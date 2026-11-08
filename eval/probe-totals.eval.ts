/**
 * 探针：列合计真的进到工具返回里了吗（不花 LLM 钱，只查库）。
 *
 * 这不是评测，是"改完之后亲眼看一眼"：D07 那条 SQL 的结果现在带不带 mrr 合计。
 */
import { describe, expect, it } from 'vitest';

import { runReadOnlyQuery } from '../src/lib/agent-db';
import { columnTotals } from '../src/lib/column-totals';

const SQL = `SELECT p.name AS plan, CASE WHEN s.billing_cycle = 'monthly'
  THEN p.monthly_price + s.seats * p.seat_price
  ELSE p.annual_price / 12.0 + s.seats * p.seat_price END AS mrr, s.seats
FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'
ORDER BY mrr DESC`;

describe('列合计探针', () => {
  it('D07 的结果带出 mrr / seats 合计', async () => {
    const r = await runReadOnlyQuery(SQL);
    console.log('columns:', r.columns, 'numeric:', r.numericColumns, 'rows:', r.rowCount);
    const t = columnTotals(r.columns, r.numericColumns, r.rows, { truncated: r.truncated });
    console.log('truncated:', r.truncated, 'totals:', JSON.stringify(t));
    expect(r.numericColumns).toContain('mrr');
    // 1000 行被杀在 MAX_ROWS 上 → 拒绝出合计（否则会顶着"覆盖全部"的说法给个错数）
    expect(t).toEqual([]);
  });

  it('不截断的聚合结果能出合计', async () => {
    const r = await runReadOnlyQuery(
      `SELECT ch.name AS 渠道, count(*) AS 订单数, sum(o.total_amount - o.discount_amount) AS 实收
       FROM orders o JOIN channels ch ON ch.id = o.channel_id
       WHERE o.status <> 'cancelled' GROUP BY ch.name ORDER BY 实收 DESC`,
    );
    const t = columnTotals(r.columns, r.numericColumns, r.rows, { truncated: r.truncated });
    console.log('rows:', r.rowCount, 'truncated:', r.truncated, 'totals:', JSON.stringify(t));
    expect(t.map((x) => x.column)).toEqual(['订单数', '实收']);
  });
});
