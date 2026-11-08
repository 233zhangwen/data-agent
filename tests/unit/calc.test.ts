import { describe, expect, it } from 'vitest';

import { calculate, toScaled } from '@/lib/calc';

/**
 * 这个模块的存在理由是 D07：模型心算 6 个数字的和，算错了 15.7 万。
 * 所以测试的重点不是"加减乘除对不对"（那是 BigInt 的事），而是：
 *   1. 金额场景常见的误差（0.1+0.2、浮点尾数）必须精确
 *   2. 输入不合法时报错，而不是猜（模型传 "198.4万" 时不能静默当 198.4）
 *
 * 原来的第 3 条测的是 `verify_sum`（自检工具）。它已删除 —— 313 次运行 0 调用，
 * 自检改成"结果自带列合计"（column-totals.ts），D07 的回归用例搬到了
 * tests/unit/column-totals.test.ts。
 */

describe('toScaled：解析', () => {
  it('接受千分位逗号与空格', () => {
    expect(toScaled('1,234.5')).toEqual({ n: BigInt(12345), s: 1 });
    expect(toScaled(' 1 234 ')).toEqual({ n: BigInt(1234), s: 0 });
  });

  it('负数与前导零', () => {
    expect(toScaled('-0.25')).toEqual({ n: BigInt(-25), s: 2 });
    expect(toScaled('007')).toEqual({ n: BigInt(7), s: 0 });
    expect(toScaled('0.0')).toEqual({ n: BigInt(0), s: 1 });
  });

  it('带单位的字符串直接报错（不猜）', () => {
    expect(() => toScaled('198.4万')).toThrow(/不是有效数字/);
    expect(() => toScaled('abc')).toThrow(/不是有效数字/);
  });
});

describe('sum：求和', () => {
  it('D07 的六个分项', () => {
    const r = calculate({ op: 'sum', values: [198.4, 107.0, 107.1, 64.0, 43.5, 27.9], decimals: 1, unit: '万元' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(547.9);
    expect(r.display).toBe('547.9 万元');
  });

  it('0.1 + 0.2 = 0.3（Number 会得到 0.30000000000000004）', () => {
    const r = calculate({ op: 'sum', values: [0.1, 0.2], decimals: 2 });
    expect(r.ok && r.value).toBe(0.3);
  });

  it('scale 不同也要对齐', () => {
    const r = calculate({ op: 'sum', values: [1, 0.001, 2.5], decimals: 3 });
    expect(r.ok && r.value).toBe(3.501);
  });

  it('空 values 报错', () => {
    expect(calculate({ op: 'sum', values: [] }).ok).toBe(false);
  });
});

describe('diff / avg / ratio / pct_change', () => {
  it('diff 第一个减其余', () => {
    const r = calculate({ op: 'diff', values: [100, 30, 20], decimals: 0 });
    expect(r.ok && r.value).toBe(50);
  });

  it('diff 允许结果为负', () => {
    const r = calculate({ op: 'diff', values: [10, 25], decimals: 0 });
    expect(r.ok && r.value).toBe(-15);
  });

  it('avg 六项', () => {
    const r = calculate({ op: 'avg', values: [198.4, 107.0, 107.1, 64.0, 43.5, 27.9], decimals: 2 });
    expect(r.ok && r.value).toBe(91.32);
  });

  it('ratio 两个数', () => {
    const r = calculate({ op: 'ratio', values: [3, 8], decimals: 4 });
    expect(r.ok && r.value).toBe(0.375);
  });

  it('ratio 除零报错而不是返回 Infinity', () => {
    const r = calculate({ op: 'ratio', values: [1, 0] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/除数为 0/);
  });

  it('pct_change 增长', () => {
    const r = calculate({ op: 'pct_change', values: [120, 100], decimals: 1 });
    expect(r.ok && r.value).toBe(20);
    if (r.ok) expect(r.display).toBe('+20.0%');
  });

  it('pct_change 下降带负号、不加 +', () => {
    const r = calculate({ op: 'pct_change', values: [80, 100], decimals: 1 });
    expect(r.ok && r.value).toBe(-20);
    if (r.ok) expect(r.display).toBe('-20.0%');
  });

  it('参数个数不对时明确报错', () => {
    expect(calculate({ op: 'ratio', values: [1, 2, 3] }).ok).toBe(false);
    expect(calculate({ op: 'pct_change', values: [1] }).ok).toBe(false);
  });
});
