/**
 * 每 IP 提问次数限制。
 *
 * 定位：口令门是主防线（挡爬虫和路人），限流是**第二道**——挡"拿到了口令的人"
 * 或者口令被转发出去之后的滥用。两者叠加才够（docs/DEPLOY.md 第 3 节）。
 *
 * ⚠️ 一个必须说清楚的限制：这里是**进程内存**计数。本地和单实例部署有效；
 * Netlify Functions 每个实例独立，同一 IP 的请求落到不同实例时各自的计数都从 0 开始，
 * 实际阈值会放大到「实例数 × limit」。要跨实例精确限流，计数必须放进数据库
 * （原子 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`）。这条路已经留好接口
 * （`storage`），但没做 —— 需要一次 Prisma 迁移，列在 W4 待办里。
 * 写在这里而不是只写在文档里，是因为"以为限流生效了"比"没限流"更危险。
 *
 * 纯逻辑 + 可注入的时钟，便于单测（tests/unit/rate-limit.test.ts）。
 */

export type RateLimitDecision =
  | { ok: true; used: number; limit: number }
  | { ok: false; used: number; limit: number; retryAfterSec: number };

type Storage = Map<string, number[]>;

export type RateLimiterOptions = {
  /** 窗口内允许的次数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 注入时钟，测试用。 */
  now?: () => number;
  /** 注入存储（将来的 DB 版本换掉这里）。 */
  storage?: Storage;
};

export type RateLimiter = {
  check(key: string): RateLimitDecision;
  /** 只读当前用量，不计数（给日志/响应头用）。 */
  peek(key: string): number;
  reset(): void;
  /** 当前跟踪的 key 数，用于观察内存占用。 */
  size(): number;
};

/** 超过这个 key 数就做一次全表清扫，防止 IP 多样性把内存撑爆。 */
const SWEEP_AT = 5000;

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = opts;
  const now = opts.now ?? (() => Date.now());
  const hits: Storage = opts.storage ?? new Map<string, number[]>();
  /** 上次全表清扫的时间。过期 key 不清会一直占着内存，size 只涨不跌。 */
  let lastSweep = now();

  function prune(key: string, at: number): number[] {
    const list = hits.get(key);
    if (!list) return [];
    const kept = list.filter((t) => at - t < windowMs);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
  }

  function sweep(at: number): void {
    for (const key of Array.from(hits.keys())) prune(key, at);
  }

  return {
    check(key) {
      const at = now();
      // 每个窗口至少扫一次；key 太多时立刻扫（IP 多样性不该把内存撑爆）
      if (at - lastSweep >= windowMs || hits.size > SWEEP_AT) {
        sweep(at);
        lastSweep = at;
      }

      const list = prune(key, at);
      if (list.length >= limit) {
        const oldest = list[0];
        const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - at) / 1000));
        return { ok: false, used: list.length, limit, retryAfterSec };
      }
      list.push(at);
      hits.set(key, list);
      return { ok: true, used: list.length, limit };
    },

    peek(key) {
      return prune(key, now()).length;
    },

    reset() {
      hits.clear();
      lastSweep = now();
    },

    size() {
      return hits.size;
    },
  };
}

/**
 * 从请求头取客户端 IP。
 *
 * Netlify 给的是 `x-nf-client-connection-ip`；本地 dev 没有这个头，退回
 * `x-forwarded-for` 的第一跳。都取不到时**返回 'unknown' 而不是随机值** ——
 * 随机值等于给每个请求发一张新额度；共用一个桶至少还能挡住"同一台机器连发"。
 */
export function clientIp(headers: Headers): string {
  const direct = headers.get('x-nf-client-connection-ip');
  if (direct) return direct.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

/** 进程级单例：dev 热重载会重复执行模块，挂 globalThis 免得计数被重置。 */
const globalForLimiter = globalThis as unknown as { __askRateLimiter?: RateLimiter };

export function getAskRateLimiter(): RateLimiter {
  if (!globalForLimiter.__askRateLimiter) {
    const limit = Number(process.env.ASK_RATE_LIMIT_PER_HOUR ?? '20') || 20;
    globalForLimiter.__askRateLimiter = createRateLimiter({
      limit,
      windowMs: 60 * 60 * 1000,
    });
  }
  return globalForLimiter.__askRateLimiter;
}
