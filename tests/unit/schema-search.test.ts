import { describe, expect, it } from 'vitest';

import { rankTables, tokenize } from '../../src/lib/schema-search';
import { TABLE_DOCS } from '../../src/lib/schema-docs';

describe('tokenize', () => {
  it('英文词 + snake_case 拆分', () => {
    expect(tokenize('subscription_seats')).toEqual(['subscription_seats', 'subscription', 'seats']);
  });

  it('中文按 2-gram 切', () => {
    const tokens = tokenize('复购率');
    expect(tokens).toContain('复购');
    expect(tokens).toContain('购率');
    expect(tokens).not.toContain('复购率'); // 3-gram 不产生
  });

  it('单字查询也保留（降级为字匹配）', () => {
    expect(tokenize('单')).toEqual(['单']);
  });
});

describe('rankTables', () => {
  it('「复购」命中订阅链的表', () => {
    const r = rankTables('上个月哪个客户群体复购率最高', TABLE_DOCS, 3);
    expect(r.length).toBeGreaterThan(0);
    const names = r.map((x) => x.table);
    // 复购 = 客户重复下单：customers 必须在前三，订阅链的表也应出现
    expect(names).toContain('customers');
    expect(r[0].score).toBeGreaterThan(0);
  });

  it('「退货」指向 returns / order_items 而不是 orders', () => {
    const r = rankTables('退货率最高的商品', TABLE_DOCS, 3);
    const names = r.map((x) => x.table);
    expect(names).toContain('returns');
    // returns 明确写着"退货挂在 order_items 上"，它比 orders 更该被选中
    expect(names.indexOf('returns')).toBeLessThan(
      names.indexOf('orders') === -1 ? Number.MAX_SAFE_INTEGER : names.indexOf('orders'),
    );
  });

  it('问题里直接写表名时，该表排第一（精确指向加分）', () => {
    const r = rankTables('orders 表一共有多少行', TABLE_DOCS, 3);
    expect(r[0].table).toBe('orders');
  });

  it('matched 非空，且命中词确实来自查询', () => {
    const q = '哪个渠道来的客户付费最多';
    const r = rankTables(q, TABLE_DOCS, 5);
    const qTokens = new Set(tokenize(q));
    for (const item of r) {
      expect(item.matched.length).toBeGreaterThan(0);
      for (const m of item.matched) expect(qTokens.has(m)).toBe(true);
    }
  });

  it('完全不相关的查询返回空（宁缺勿滥，不给零分表）', () => {
    const r = rankTables('哈哈哈哈', TABLE_DOCS, 5);
    expect(r).toEqual([]);
  });

  it('确定性：同一输入两次结果完全一致', () => {
    const q = '企业客户每月的订阅收入和发票金额';
    expect(rankTables(q, TABLE_DOCS, 5)).toEqual(rankTables(q, TABLE_DOCS, 5));
  });
});
