import { describe, expect, it } from 'vitest';

import { columnTotals } from '@/lib/column-totals';

/**
 * 这一节是 D07 的正解。
 *
 * 原来的正解是一个 `verify_sum` 工具（把分项之和与你给出的合计比对），
 * 313 次真实运行里**一次都没被调用**。所以换了个位置：把合计放进 runSql 的结果里，
 * 模型要做的是抄一个数，不是加六个数。
 *
 * 因此这里要证明的不是"能算对"（BigInt 本来就算得对），而是三件事：
 *   1. 该算的列算出来了，且是精确值（D07 那六个数字）
 *   2. 不该算的列必须**不算** —— 加了比不加更危险（比率相加、id 相加）
 *   3. 有脏值就整列放弃 —— 半对半错的合计会让模型引一个错数
 */

const ROWS = [
  { plan: '团队版-年付', mrr: '198.4', seats: 120 },
  { plan: '团队版-月付', mrr: '107.0', seats: 80 },
  { plan: '企业版-年付', mrr: '107.1', seats: 34 },
  { plan: '企业版-月付', mrr: '64.0', seats: 22 },
  { plan: '专业版-年付', mrr: '43.5', seats: 41 },
  { plan: '专业版-月付', mrr: '27.9', seats: 19 },
];

describe('D07 回归：六行明细的合计', () => {
  it('mrr 合计 = 547.9（模型当年心算成 563.6，差 15.7 万）', () => {
    const t = columnTotals(['plan', 'mrr', 'seats'], ['mrr', 'seats'], ROWS);
    const mrr = t.find((x) => x.column === 'mrr');
    expect(mrr?.text).toBe('547.9');
    expect(mrr?.count).toBe(6);
  });

  it('整数列保留整数形态，不补无意义的小数位', () => {
    const t = columnTotals(['plan', 'mrr', 'seats'], ['mrr', 'seats'], ROWS);
    expect(t.find((x) => x.column === 'seats')?.text).toBe('316');
  });

  it('非数值列（plan）不出现在结果里', () => {
    const t = columnTotals(['plan', 'mrr', 'seats'], ['mrr', 'seats'], ROWS);
    expect(t.map((x) => x.column)).toEqual(['mrr', 'seats']);
  });
});

describe('不该算的列', () => {
  it('数据库没说是数值类型的列，即使值看着像数字也不算', () => {
    // '2026' 是文本列（比如月份字符串）：只有数据库知道，我们不信值的样子
    const rows = [{ label: '2026', n: 1 }, { label: '2025', n: 2 }];
    const t = columnTotals(['label', 'n'], ['n'], rows);
    expect(t.map((x) => x.column)).toEqual(['n']);
  });

  it('id / year / month 这类列名一律跳过（相加没有意义，还会被误引用）', () => {
    const rows = [
      { user_id: 1, year: 2025, revenue: 10 },
      { user_id: 2, year: 2026, revenue: 20 },
    ];
    const t = columnTotals(['user_id', 'year', 'revenue'], ['user_id', 'year', 'revenue'], rows);
    expect(t.map((x) => x.column)).toEqual(['revenue']);
  });

  it('只有一行时不出合计（合计等于该值，是噪音）', () => {
    expect(columnTotals(['mrr'], ['mrr'], [{ mrr: 100 }])).toEqual([]);
  });

  it('结果被截断时不出合计（那是前 N 行的和，不是总数）', () => {
    // 实测踩到：D07 的 SQL 返回 1000 行被杀在 MAX_ROWS 上，合计只加了前 1000 行
    expect(columnTotals(['mrr'], ['mrr'], ROWS, { truncated: true })).toEqual([]);
  });
});

describe('脏数据与边界', () => {
  it('某一列里混进非数字时整列放弃（不做"跳过脏值"的部分求和）', () => {
    const rows = [
      { mrr: '10.0' },
      { mrr: 'N/A' },
      { mrr: '20.0' },
    ];
    expect(columnTotals(['mrr'], ['mrr'], rows)).toEqual([]);
  });

  it('NULL 不参与相加，但不算脏值（SQL sum() 的语义）', () => {
    const rows = [{ mrr: '10.5' }, { mrr: null }, { mrr: '20.5' }];
    const t = columnTotals(['mrr'], ['mrr'], rows);
    // 小数位最多两位，且末尾的 0 会被剥掉（10.5 + 20.5 = 31.0 → 31）
    expect(t[0].text).toBe('31');
    expect(t[0].count).toBe(2);
  });

  it('负数（退款）也照算，四舍五入方向与正数一致', () => {
    const rows = [{ amt: '100.05' }, { amt: '-100.04' }];
    expect(columnTotals(['amt'], ['amt'], rows)[0].text).toBe('0.01');
    // 超过两位的小数四舍五入到两位（-1.005 → -1.01，负数方向与正数一致）
    const rows2 = [{ amt: '-1.005' }, { amt: '0' }];
    expect(columnTotals(['amt'], ['amt'], rows2)[0].text).toBe('-1.01');
  });

  it('整数不被剥零误伤（100 不能变成 1）', () => {
    const rows = [{ v: 60 }, { v: 40 }];
    expect(columnTotals(['v'], ['v'], rows)[0].text).toBe('100');
  });

  it('最多给 6 列（宽表塞满合计反而让模型引错数）', () => {
    const cols = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = cols.map((c) => Object.fromEntries(cols.map((x) => [x, c === x ? 1 : 1])));
    expect(columnTotals(cols, cols, rows)).toHaveLength(6);
  });

  it('浮点尾数不进来：0.1 + 0.2 = 0.3，不是 0.30000000000000004', () => {
    const rows = [{ v: 0.1 }, { v: 0.2 }];
    expect(columnTotals(['v'], ['v'], rows)[0].text).toBe('0.3');
  });
});
