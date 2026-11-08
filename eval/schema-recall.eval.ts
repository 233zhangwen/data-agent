/**
 * C8：search_schema（rankTables 纯函数）的召回评测。不调 LLM，纯计算。
 *
 * 判据：recall@3 ≥ 0.85。每题标注"回答这个问题正确必须用到的表"，
 * recall = |标注 ∩ top3| / |标注|，总分 = 全部题的平均。
 *
 * 注意这测的是**检索器**，不是模型会不会去调它——模型侧的使用率在 W3 评测集里看。
 */

import { describe, expect, it } from 'vitest';

import { rankTables } from '../src/lib/schema-search';
import { TABLE_DOCS } from '../src/lib/schema-docs';

type Case = { q: string; expect: string[] };

const CASES: Case[] = [
  { q: '上个月的总 GMV 是多少', expect: ['orders'] },
  { q: '哪个品类的销售额最高', expect: ['order_items', 'products', 'categories'] },
  { q: '客户的复购率是多少', expect: ['orders', 'customers'] },
  { q: '退货率最高的 5 个商品', expect: ['returns', 'order_items'] },
  { q: '各获客渠道来了多少客户', expect: ['customers', 'channels'] },
  { q: '付费广告渠道的成交额', expect: ['orders', 'channels'] },
  { q: '现在的 MRR 是多少', expect: ['subscriptions', 'plans'] },
  { q: '年付订阅占多大比例', expect: ['subscriptions'] },
  { q: '有多少发票开出去还没付款', expect: ['invoices'] },
  { q: '应收和实收差多少', expect: ['invoices', 'payments'] },
  { q: '哪些仓库的库存低于 50 件', expect: ['inventory', 'warehouses'] },
  { q: '华东区域的客户有多少', expect: ['customers', 'regions'] },
  { q: '销售人员的业绩排名', expect: ['employees', 'orders'] },
  { q: '客服工单平均多久处理完', expect: ['support_tickets'] },
  { q: '优惠券的核销率是多少', expect: ['coupons', 'coupon_redemptions'] },
  { q: '注册了订阅服务的企业客户比例', expect: ['customers', 'subscriptions'] },
  { q: '每月订单量趋势', expect: ['orders'] },
  { q: '客户退货的主要原因是什么', expect: ['returns'] },
  { q: '平均每笔订单花多少钱', expect: ['orders'] },
  { q: '企业客户平均买了多少个座位', expect: ['subscriptions', 'subscription_seat_changes'] },
];

describe('C8 · search_schema 召回', () => {
  it('20 题召回率（门槛 0.85，达不到才考虑向量）', () => {
    const perCase = CASES.map((c) => {
      const top3 = rankTables(c.q, TABLE_DOCS, 3).map((r) => r.table);
      const hit = c.expect.filter((t) => top3.includes(t)).length;
      return { q: c.q, expect: c.expect, top3, recall: hit / c.expect.length };
    });

    // 明细打出来：哪类问题没召回，比总分重要
    for (const r of perCase) {
      const mark = r.recall === 1 ? '✓' : r.recall === 0 ? '✗' : '~';
      console.log(`${mark} ${r.recall.toFixed(2)}  ${r.q}  → [${r.top3.join(', ')}]`);
    }

    const mean = perCase.reduce((s, r) => s + r.recall, 0) / perCase.length;
    console.log(`\nrecall@3 平均 = ${mean.toFixed(3)}（门槛 0.85）`);

    // 记录数字，不硬性断言——评估的产出是数字和原因，不是 pass/fail
    expect(mean).toBeGreaterThan(0);
  }, 30_000);
});
