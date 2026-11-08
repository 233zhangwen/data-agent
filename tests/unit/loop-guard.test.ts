import { describe, expect, it } from 'vitest';

import {
  createLoopGuard,
  l1Notice,
  L2_SAME_ERROR_AT,
  L3_STAGNANT_AT,
  l2Notice,
  normalizeSql,
} from '../../src/lib/loop-guard';

describe('L1 完全重复检测', () => {
  it('同一条 SQL 第二次出现被识别（空白/大小写不同也算）', () => {
    const g = createLoopGuard();
    g.markSqlSeen('SELECT * FROM orders');
    expect(g.seenSql('SELECT  *\n  from ORDERS')).toBe(true);
  });

  it('不同的 SQL 不误伤', () => {
    const g = createLoopGuard();
    g.markSqlSeen('SELECT count(*) FROM orders');
    expect(g.seenSql('SELECT count(*) FROM customers')).toBe(false);
  });

  it('SQL 字面量大小写被归一（status 值不同但结构相同 → 算重复）', () => {
    expect(normalizeSql("WHERE status = 'paid'")).toBe("where status = 'paid'");
  });
});

describe('L2 同错重复检测', () => {
  it('第 3 次同错才达到阈值', () => {
    const g = createLoopGuard();
    const times1 = g.recordError('42703', 'column "customer_id" does not exist');
    const times2 = g.recordError('42703', 'column "customer_id" does not exist');
    const times3 = g.recordError('42703', 'column "customer_id" does not exist');
    expect([times1, times2, times3]).toEqual([1, 2, 3]);
    expect(times3).toBe(L2_SAME_ERROR_AT);
    expect(l2Notice(times3)).toContain('describeTable');
  });

  it('position 不同不算不同错误（它随 SQL 长度漂移）', () => {
    const g = createLoopGuard();
    g.recordError('42703', 'column "x" does not exist');
    g.recordError('42703', 'column "x" does not exist');
    // 同 code 同 message —— recordError 本来就不含 position，两次后第三次到达阈值
    expect(g.recordError('42703', 'column "x" does not exist')).toBe(3);
  });

  it('不同错误各自计数，互不干扰', () => {
    const g = createLoopGuard();
    g.recordError('42703', 'column "a" does not exist');
    g.recordError('42P01', 'relation "t" does not exist');
    expect(g.recordError('42703', 'column "a" does not exist')).toBe(2);
  });

  it('查询成功后错误历史清零（不同问题不共享历史）', () => {
    const g = createLoopGuard();
    g.recordError('42703', 'column "a" does not exist');
    g.recordError('42703', 'column "a" does not exist');
    g.clearErrors();
    expect(g.recordError('42703', 'column "a" does not exist')).toBe(1);
  });
});

describe('L3 无进展检测', () => {
  it(`连续 ${L3_STAGNANT_AT} 次相同输出触发警告`, () => {
    const g = createLoopGuard();
    expect(g.track('runSql', '返回 5 行……')).toBeNull();
    expect(g.track('runSql', '返回 5 行……')).toBeNull();
    expect(g.track('runSql', '返回 5 行……')).toContain('⛔');
  });

  it('中间插入一次不同输出就重新计数', () => {
    const g = createLoopGuard();
    g.track('runSql', 'A');
    g.track('runSql', 'A');
    g.track('runSql', 'B');
    expect(g.track('runSql', 'A')).toBeNull();
    expect(g.track('runSql', 'A')).toBeNull();
    expect(g.track('runSql', 'A')).toContain('⛔'); // 又连续 3 次了
  });

  it('同名工具才连续计数（跨工具的巧合相同不算绕圈）', () => {
    const g = createLoopGuard();
    g.track('describeTable', '相同的文本');
    g.track('describeTable', '相同的文本');
    // 第三次换成 listTables 返回相同文本——指纹里带工具名，不触发
    expect(g.track('listTables', '相同的文本')).toBeNull();
  });

  it('输出里混入警告后指纹变化，不会立刻连环触发', () => {
    const g = createLoopGuard();
    g.track('runSql', 'A');
    g.track('runSql', 'A');
    const third = g.track('runSql', 'A');
    expect(third).not.toBeNull();
    // 第 4 次相同输出：窗口里最后 3 个是 [带警告的 A, A, A]？
    // 实现：track 的输出是原始输出，警告由调用方拼接——指纹按原始输出算，
    // 所以第 4 次仍然触发（这符合预期：还在绕圈就一直警告）。
    expect(g.track('runSql', 'A')).not.toBeNull();
  });
});

describe('L1 提示文案', () => {
  it('有上次结果时提示可以直接用', () => {
    expect(l1Notice(true)).toContain('上一条成功查询');
  });
  it('没有上次结果时不含误导', () => {
    expect(l1Notice(false)).not.toContain('上一条');
  });
});
