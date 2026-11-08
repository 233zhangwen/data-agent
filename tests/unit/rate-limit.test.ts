import { describe, expect, it } from 'vitest';

import { clientIp, createRateLimiter } from '@/lib/rate-limit';

/**
 * 限流的测试用**假时钟**，不 sleep。窗口类的逻辑一旦用真实时间写测试，
 * 就会变成"偶尔失败"的那种测试，然后被人加 retry 掩盖掉。
 */

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createRateLimiter', () => {
  it('前 N 次放行，第 N+1 次拒绝', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });

    expect(rl.check('1.1.1.1').ok).toBe(true);
    expect(rl.check('1.1.1.1').ok).toBe(true);
    expect(rl.check('1.1.1.1').ok).toBe(true);
    const blocked = rl.check('1.1.1.1');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.used).toBe(3);
      expect(blocked.limit).toBe(3);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('窗口滑过去之后恢复', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    expect(rl.check('ip').ok).toBe(true);
    expect(rl.check('ip').ok).toBe(false);

    c.advance(59_999);
    expect(rl.check('ip').ok).toBe(false);

    c.advance(1);
    expect(rl.check('ip').ok).toBe(true);
  });

  it('不同 key 互不影响（一个 IP 刷爆不该连累别人）', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('a').ok).toBe(false);
    expect(rl.check('b').ok).toBe(true);
  });

  it('retryAfter 说的是"最早那次过期还要多久"，不是整个窗口', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
    rl.check('ip'); // t=0
    c.advance(45_000);
    rl.check('ip'); // t=45s
    c.advance(1_000); // t=46s
    const blocked = rl.check('ip');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBe(14); // 60 - 46
  });

  it('peek 不计数，只报用量', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 5, windowMs: 60_000, now: c.now });
    rl.check('ip');
    expect(rl.peek('ip')).toBe(1);
    expect(rl.peek('ip')).toBe(1);
    expect(rl.peek('never-seen')).toBe(0);
  });

  it('过期的 key 会被清掉，内存不会一直涨', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    rl.check('a');
    rl.check('b');
    expect(rl.size()).toBe(2);
    c.advance(2_000);
    rl.check('c'); // 触发 a/b 的清理（prune 在 check 里做）
    expect(rl.size()).toBe(1);
  });

  it('reset 清空（测试与运维手动解封都用它）', () => {
    const c = clock();
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    rl.check('a');
    rl.reset();
    expect(rl.check('a').ok).toBe(true);
  });
});

describe('clientIp', () => {
  it('优先用 Netlify 的直连 IP 头', () => {
    const h = new Headers({
      'x-nf-client-connection-ip': '203.0.113.9',
      'x-forwarded-for': '10.0.0.1, 10.0.0.2',
    });
    expect(clientIp(h)).toBe('203.0.113.9');
  });

  it('退回 x-forwarded-for 的第一跳', () => {
    const h = new Headers({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' });
    expect(clientIp(h)).toBe('198.51.100.7');
  });

  it('都没有时归到同一个 unknown 桶（而不是给每个请求发新额度）', () => {
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
