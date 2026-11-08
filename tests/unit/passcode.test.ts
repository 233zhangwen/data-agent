import { describe, expect, it } from 'vitest';

import {
  checkPasscode,
  constantTimeEqual,
  hashPasscode,
  isValidPasscodeCookie,
  safeNext,
} from '@/lib/passcode';

/**
 * 口令门的测试重点不是"sha256 算得对不对"（那是 WebCrypto 的事），而是三个
 * 容易写成"看起来在工作"的地方：
 *   1. 没配口令时必须**拒绝**（而不是"没有口令=谁都能进"）
 *   2. 空输入不能通过
 *   3. next 参数不能把人带到站外（开放重定向）
 */

describe('hashPasscode', () => {
  it('同一个口令稳定产出 64 位十六进制', async () => {
    const a = await hashPasscode('afei-demo-2026');
    const b = await hashPasscode('  afei-demo-2026  ');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b); // 前后空格被 trim，避免复制粘贴带空格进不来
  });

  it('不同口令产出不同哈希（含只差一个字符）', async () => {
    expect(await hashPasscode('abc')).not.toBe(await hashPasscode('abd'));
  });
});

describe('checkPasscode', () => {
  it('口令对得上', async () => {
    expect(await checkPasscode('open-sesame', 'open-sesame')).toBe(true);
  });

  it('口令不对', async () => {
    expect(await checkPasscode('wrong', 'open-sesame')).toBe(false);
  });

  it('服务端没配口令时一律不通过（不能退化成"谁都能进"）', async () => {
    expect(await checkPasscode('', undefined)).toBe(false);
    expect(await checkPasscode('anything', undefined)).toBe(false);
    expect(await checkPasscode('', '')).toBe(false);
    expect(await checkPasscode('   ', '   ')).toBe(false);
  });

  it('空输入不通过', async () => {
    expect(await checkPasscode('', 'open-sesame')).toBe(false);
  });
});

describe('cookie 校验', () => {
  it('cookie = sha256(口令) 时通过', async () => {
    const expected = 'open-sesame';
    expect(await isValidPasscodeCookie(await hashPasscode(expected), expected)).toBe(true);
  });

  it('cookie 里放明文口令不算通过（必须存哈希）', async () => {
    expect(await isValidPasscodeCookie('open-sesame', 'open-sesame')).toBe(false);
  });

  it('没有 cookie / 没有配置时都不通过', async () => {
    expect(await isValidPasscodeCookie(undefined, 'x')).toBe(false);
    expect(await isValidPasscodeCookie('abc', undefined)).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('等长不等值 / 不等长 / 相等', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('safeNext：不许把人带到站外', () => {
  it('站内路径放行', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/settings?tab=1')).toBe('/settings?tab=1');
  });

  it('协议相对与外站一律退回首页', () => {
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
  });
});
