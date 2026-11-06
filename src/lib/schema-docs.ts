/**
 * 21 张业务表的**语义说明**。
 *
 * 这不是 DDL（列名、类型由 `describe_table` 实时查 information_schema 得到，
 * 那份永远不会和真实表结构漂移）。这里只写 DDL 里没有的东西：
 *   这张表回答什么问题 · 和其它表怎么连 · **哪里容易写错**
 *
 * 第三点最重要。"算 GMV 要排除 cancelled"、"退货挂在 order_items 不是 orders"、
 * "一张账单可能分多次支付" —— 这些是分析师的口口相传，模型不知道就会写出一条
 * 语法正确、结果错误、而且不报错的 SQL。这类错误比报错危险得多。
 */

export type TableDoc = {
  table: string;
  /** 一句话：这张表干什么 */
  summary: string;
  /** 关键列与连接方式 */
  columns: string;
  /** ⚠️ 常见错误 */
  pitfall?: string;
};

export const TABLE_DOCS: TableDoc[] = [
  // ---------------- 维度 ----------------
  {
    table: 'regions',
    summary: '销售区域。6 条：华东/华北/华南/西南/华中/海外。',
    columns: 'id, name, code。被 customers / employees / warehouses 引用。',
  },
  {
    table: 'channels',
    summary: '获客渠道。5 条：自然搜索/付费广告/转介绍/展会活动/内容营销。',
    columns: 'id, name。customers.channel_id 记录客户首次来源，orders.channel_id 记录该单成交渠道。',
    pitfall: '两个 channel_id 不是一回事：客户来源是"第一次怎么来的"，订单渠道是"这一单在哪成交"。渠道 ROI 分析要用 orders.channel_id。',
  },
  {
    table: 'employees',
    summary: '员工。role 分 sales（销售，25 人）和 support（客服，15 人）。',
    columns: 'id, name, role, region_id（可空）, hired_at。被 orders.sales_rep_id 和 support_tickets.assigned_to_id 引用。',
    pitfall: '只有 sales 会出现在 orders.sales_rep_id 里；support 出现在工单里。按业绩排名要先过滤 role = \'sales\'。',
  },

  // ---------------- 电商 ----------------
  {
    table: 'customers',
    summary: '客户主表，两条业务线共用。type 分 individual / business，SaaS 订阅只发生在 business 上。',
    columns: 'id, name, type, email, region_id, channel_id, signed_up_at。被 orders / subscriptions / support_tickets / coupon_redemptions 引用。',
    pitfall: '算「客户总数」时注意这里是**注册总数**，不等于下过单的人（有相当比例注册未转化）。要算活跃客户得 join orders 去重。',
  },
  {
    table: 'categories',
    summary: '商品品类，两级：4 个一级（智能硬件/办公设备/配件耗材/家居电子），下挂 12 个二级。',
    columns: 'id, name, parent_id（自关联，一级为 null）。',
    pitfall: '按"一级品类"统计要向上取一层 parent_id，直接用 products.category_id 只到二级。',
  },
  {
    table: 'products',
    summary: '商品（SPU），有品牌、基础价、上架时间、状态（active/discontinued）。',
    columns: 'id, name, category_id, brand, base_price, status, launched_at。',
    pitfall: 'base_price 是标价，不是成交价 —— 成交价在 order_items.unit_price。',
  },
  {
    table: 'product_variants',
    summary: '商品规格（SKU），每个商品 3 个规格（标准/升级/尊享）。',
    columns: 'id, product_id, sku, name, price。被 order_items / inventory 引用。',
    pitfall: '销量、库存、退货都精确到 SKU 这一层，不是 products。要按商品统计得 join 回 product_id。',
  },
  {
    table: 'warehouses',
    summary: '仓库，5 个（上海/北京/广州/成都/新加坡）。',
    columns: 'id, name, region_id。被 inventory / shipments 引用。',
  },
  {
    table: 'inventory',
    summary: '库存快照，每个 SKU 在每个仓一行。',
    columns: 'id, variant_id, warehouse_id, quantity, updated_at。',
    pitfall: 'quantity 是**当前**快照，不是历史流水。算"缺货 SKU 数"要按 variant 聚合后再判断，不是按行。',
  },
  {
    table: 'orders',
    summary: '订单主表，一笔交易一行。覆盖最近 12 个月。',
    columns:
      'id, order_no, customer_id, channel_id, sales_rep_id（可空）, status, ordered_at, paid_at, ' +
      'total_amount（商品金额含运费）, discount_amount, shipping_fee。',
    pitfall:
      '① status 有 cancelled，算营收/GMV 必须排除（`status <> \'cancelled\'`），否则数字虚高；' +
      '② 实收 = total_amount - discount_amount；' +
      '③ 复购要按 customer_id 去重计数，不是订单数；' +
      '④ paid_at 可能为 null（pending / cancelled）。',
  },
  {
    table: 'order_items',
    summary: '订单明细，一行一个 SKU。',
    columns: 'id, order_id, variant_id, quantity, unit_price, subtotal。',
    pitfall: 'subtotal = quantity × unit_price，已含数量。求和不要再乘 quantity。',
  },
  {
    table: 'shipments',
    summary: '发货记录，只有 shipped / delivered 的订单才有。',
    columns: 'id, order_id, warehouse_id, carrier, tracking_no, shipped_at, delivered_at。',
    pitfall: 'delivered_at 可能为 null（还在途）。算"平均履约时长"要过滤掉 null。',
  },
  {
    table: 'returns',
    summary: '退货记录。',
    columns: 'id, order_item_id（**不是 order_id**）, quantity, reason, refund_amount, requested_at, resolved_at。',
    pitfall:
      '① 退货挂在 **order_items** 上，要算到订单/品类必须再 join 一层；' +
      '② resolved_at 为 null 表示还在处理中；' +
      '③ 退货率的分母是订单明细行数，不是订单数。',
  },
  {
    table: 'coupons',
    summary: '优惠券，20 张。type 分 percent（百分比）和 fixed（固定金额）。',
    columns: 'id, code, type, value, min_spend, valid_from, valid_to, max_uses。',
    pitfall: 'percent 类型的 value 是百分数（如 10 表示 10%），fixed 是元。两种不能直接相加比大小。',
  },
  {
    table: 'coupon_redemptions',
    summary: '优惠券使用记录。',
    columns: 'id, coupon_id, order_id, customer_id, used_at。',
    pitfall: '这是"用过几张"，不是"发出去几张"。使用率要用它对比 coupons 总量。',
  },

  // ---------------- SaaS ----------------
  {
    table: 'plans',
    summary: '订阅套餐，3 个：基础版 / 专业版 / 企业版。',
    columns: 'id, name, code, monthly_price, annual_price, seat_price, max_seats。',
    pitfall: '年付价格是年价（annual_price），不是月价 × 12 的近似 —— 它确实略低。算 MRR 时年付要除以 12。',
  },
  {
    table: 'subscriptions',
    summary: '订阅合同，全部是企业客户。',
    columns: 'id, customer_id, plan_id, status（active/trialing/past_due/canceled）, billing_cycle（monthly/annual）, seats, started_at, canceled_at。',
    pitfall:
      '① MRR = 月付套餐价 + seats × 座位价，年付要除以 12；' +
      '② 算"当前活跃订阅"要过滤 status = \'active\'，canceled 的 canceled_at 不为空；' +
      '③ 流失率的分母是"期初活跃数"，不是全部订阅数。',
  },
  {
    table: 'subscription_seat_changes',
    summary: '席位变更流水（扩缩容）。',
    columns: 'id, subscription_id, delta, seats_after, changed_at。',
    pitfall: 'delta 有正有负。净增席位数是 sum(delta)，不是 count(*)。',
  },
  {
    table: 'invoices',
    summary: '账单，按计费周期生成（月付每月一张，年付每年一张）。',
    columns: 'id, subscription_id, period_start, period_end, amount, status（paid/open/void）, issued_at, due_at。',
    pitfall:
      '① 这是"应收"，不是"实收"—— 实收在 payments；' +
      '② 一张账单可能分多次支付（部分付款），所以 payments 行数 ≥ paid 账单数；' +
      '③ 算收入要按 period_start 归属期间，不是按 paid_at。',
  },
  {
    table: 'payments',
    summary: '支付流水。',
    columns: 'id, invoice_id, amount, method（alipay/wechat/bank_transfer/card）, status（succeeded/failed/refunded）, paid_at。',
    pitfall: '要过滤 status = \'succeeded\'，failed 的也算一笔记录但没收到钱。',
  },

  // ---------------- 服务 ----------------
  {
    table: 'support_tickets',
    summary: '客服工单。',
    columns: 'id, customer_id, assigned_to_id（可空）, subject, category, priority, status, opened_at, closed_at。',
    pitfall: 'closed_at 为 null 表示还没关。算"平均解决时长"必须过滤 null，否则整列变 null。',
  },
];

/** 表名 → 文档，给 list_tables / describe_table 用。 */
export const TABLE_DOC_MAP = new Map(TABLE_DOCS.map((d) => [d.table, d]));

/**
 * 拼给模型看的一行摘要。`list_tables` 返回的就是这个 ——
 * 21 行 × 一句话，约 900 token，比全量 DDL（上万 token）便宜一个数量级。
 */
export function oneLine(doc: TableDoc): string {
  return `${doc.table} — ${doc.summary}`;
}
