/**
 * 访问口令：挡住爬虫和路人，不让人白烧 token。
 *
 * 为什么需要它（docs/DEPLOY.md 第 3 节）：这个 demo 每问一次要烧 1.5–4 万 token。
 * 地址一旦被扫描到，余额按小时计往下掉。**别用"只在前端隐藏按钮"** —— 接口还开着
 * 等于没做，所以拦在 proxy（Edge 中间件）这一层。
 *
 * 三个设计决定：
 *   1. **cookie 里存口令的 sha256，不存口令本身**。httpOnly 已经挡住 JS 读取，
 *      但明文 cookie 在浏览器 devtools 里一眼可见 —— 口令可能会被当成"分享给别人"的
 *      东西复用到别处，不该在客户端可读的位置留底。
 *   2. **没配 DEMO_PASSCODE 时线上直接 503，而不是放行**。这是本项目一贯的取舍：
 *      安全配置缺失要"响"，不能"静默降级成没有"。本地开发（NODE_ENV !== production）
 *      放行，否则每次起 dev 都要输一遍口令。
 *   3. 无状态：不建 session 表、不发 token。口令门的目的是"不是谁都能点进来"，
 *      不是"知道谁进来了"——增加会话存储只会多一个会写错的组件。
 *
 * 纯函数 + WebCrypto（Edge 与 Node 都可用），无 IO。tests/unit/passcode.test.ts。
 */

export const PASSCODE_COOKIE = 'demo_pass';

/** 口令 cookie 的有效期：30 天。给面试官演示用，太短会让人反复输。 */
export const PASSCODE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** sha256(口令) 的十六进制串。用于 cookie 值，也用于比对。 */
export async function hashPasscode(passcode: string): Promise<string> {
  const data = new TextEncoder().encode(passcode.trim());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 定长比较。
 *
 * 严格说 sha256 的相等比较做时序攻击没有意义（攻击者拿不到中间状态），但代价是
 * 一行循环 —— 而"口令校验用 ==="这种写法会被下一个读代码的人照抄到别处。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** cookie 值是否匹配当前口令。 */
export async function isValidPasscodeCookie(
  cookieValue: string | undefined,
  expected: string | undefined,
): Promise<boolean> {
  if (!cookieValue || !expected) return false;
  const expectedHash = await hashPasscode(expected);
  return constantTimeEqual(cookieValue, expectedHash);
}

/**
 * 校验用户输入的口令。
 *
 * 空口令一律不通过 —— 否则 DEMO_PASSCODE="" 会变成"谁都能进"，
 * 而环境变量写空在部署平台上太容易发生了。
 */
export async function checkPasscode(input: string, expected: string | undefined): Promise<boolean> {
  const want = (expected ?? '').trim();
  if (!want) return false;
  return constantTimeEqual(await hashPasscode(input), await hashPasscode(want));
}

/**
 * 解锁后的跳转目标校验。
 *
 * 只接受站内绝对路径。不校验就是开放重定向：`/unlock?next=https://evil.com`
 * 会让人以为是从我们站跳走的。
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}
