/**
 * 演示数据生成器。
 *
 * 三个原则：
 *   1. **可复现**：固定随机种子，同一条命令永远生成同一份数据。否则"上次跑出来 42%，
 *      这次 39%"会变成解释不清的事故 —— 和项目 #1 的评测集一个道理。
 *   2. **数据里有故事**：不是均匀随机的噪声。双 11 有峰、春节有谷、20% 的客户贡献
 *      60% 订单、买过硬件的人更可能订阅服务。没有这些，评测问题只会得到"都一样"的答案，
 *      Agent 答对了也看不出它真会分析。
 *   3. **用纯 pg 直连**：不依赖 Prisma client。表已经由 migration 建好，
 *      这里只灌数据 —— 少一层抽象，少一处可能对不上的地方。
 *
 * 用法：
 *   npm run seed          # 清空后重灌（幂等）
 *   npm run seed -- --reset   # 显式声明（同上，留个口子给将来"增量灌"）
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------- 环境

function env(key: string): string {
  const raw = readFileSync('.env.local', 'utf8');
  const m = raw.match(new RegExp(`^${key}="?([^"\\n]+)"?`, 'm'));
  if (!m) throw new Error(`.env.local 缺少 ${key}`);
  return m[1];
}

// ---------------------------------------------------------------- 随机（可复现）

/** mulberry32：32 位状态的小 PRNG，够用且写出来就能看懂。 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261106); // 日期就是种子，改它 = 换一份数据

const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const chance = (p: number) => rand() < p;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

/** 加权抽样：权重不归一化也行。`.mts` 里泛型必须写成 `<T,>`，否则 TS7060。 */
function weighted<T,>(items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 正态分布（Box-Muller），用来让金额分布像一个真实的右偏分布。 */
function gauss(mean: number, sd: number): number {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- 时间

const NOW = new Date('2026-11-06T00:00:00Z');
const START = new Date('2025-11-01T00:00:00Z'); // 12 个月窗口

/** 月份键：2025-11 … 2026-10 */
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(START.getUTCFullYear(), START.getUTCMonth() + i, 1));
  return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, start: d };
});

/** 每个月的订单量系数：双 11 峰、春节谷、618 次峰。 */
const MONTH_WEIGHT: Record<string, number> = {
  '2025-11': 2.6, // 双 11
  '2025-12': 1.4, // 年末
  '2026-01': 1.1, // 春节前
  '2026-02': 0.6, // 春节
  '2026-03': 1.0,
  '2026-04': 1.0,
  '2026-05': 1.1,
  '2026-06': 2.0, // 618
  '2026-07': 0.95,
  '2026-08': 0.9,
  '2026-09': 1.0,
  '2026-10': 1.25, // 国庆 + 秋季
};

function randomDayIn(monthStart: Date): Date {
  const daysInMonth = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  // 上旬略少、下旬略多（发工资后消费），用两个均匀数的均值近似一个钟形
  const day = Math.min(daysInMonth, Math.max(1, Math.round((rand() * daysInMonth + rand() * daysInMonth) / 2) + 2));
  return new Date(
    Date.UTC(
      monthStart.getUTCFullYear(),
      monthStart.getUTCMonth(),
      day,
      int(0, 23),
      int(0, 59),
      int(0, 59),
    ),
  );
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

// ---------------------------------------------------------------- 数据库

const client = new Client({
  connectionString: env('DIRECT_URL'),
  ssl: { rejectUnauthorized: false },
});

/**
 * 列名转 snake_case。
 *
 * 调用侧一律写 Prisma 的 camelCase（和 schema 里的字段名一致，改起来不会错位），
 * 物理列名交给这里转 —— 表的列确实是 snake_case（@map 的结果）。
 * 把这个转换收在 helper 里，就不会出现"某处忘了转、插到一半才报错"。
 */
const toSnake = (c: string) => c.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

/** 批量插入：拼多值 VALUES，每批 500 行。13 万行这么灌大约十几秒。 */
async function insertMany(
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 500,
): Promise<void> {
  if (!rows.length) return;
  const cols = columns.map((c) => `"${toSnake(c)}"`).join(', ');
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO "${table}" (${cols}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

/**
 * 批量插入并取回自增 id。
 *
 * ⚠️ 必须批量：Neon 在新加坡，单次往返约 50ms。2 万订单逐行插入 = 1000 秒，
 * 而按 500 行一批只要 40 次往返。这不是优化，是能不能跑完的区别。
 *
 * 依赖 PostgreSQL 的行为：单条 INSERT 多组 VALUES 时，RETURNING 按插入顺序返回。
 */
async function insertReturningIds(
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 500,
): Promise<number[]> {
  if (!rows.length) return [];
  const cols = columns.map((c) => `"${toSnake(c)}"`).join(', ');
  const ids: number[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const r = await client.query<{ id: number }>(
      `INSERT INTO "${table}" (${cols}) VALUES ${tuples.join(', ')} RETURNING id`,
      values,
    );
    for (const row of r.rows) ids.push(row.id);
  }
  return ids;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  await client.connect();
  console.log('已连接，开始清空旧数据…');

  // 删表顺序必须与依赖相反，否则外键拦住
  await client.query(`
    TRUNCATE TABLE
      coupon_redemptions, coupons, returns, shipments, order_items, orders,
      inventory, product_variants, products, categories, warehouses,
      subscription_seat_changes, payments, invoices, subscriptions, plans,
      support_tickets, customers, employees, channels, regions
    RESTART IDENTITY CASCADE
  `);
  await client.query('TRUNCATE TABLE saved_queries RESTART IDENTITY CASCADE');
  console.log('旧数据已清空。\n');

  // -------------------------------------------------- 维度

  const regionRows = [
    ['华东', 'east'],
    ['华北', 'north'],
    ['华南', 'south'],
    ['西南', 'southwest'],
    ['华中', 'central'],
    ['海外', 'overseas'],
  ];
  const regionIds = await insertReturningIds('regions', ['name', 'code'], regionRows);
  const regionId = (i: number) => regionIds[i];
  console.log(`regions         ${regionIds.length}`);

  const channelRows = [
    ['自然搜索', 30],
    ['付费广告', 25],
    ['转介绍', 18],
    ['展会活动', 12],
    ['内容营销', 15],
  ] as const;
  const channelIds = await insertReturningIds(
    'channels',
    ['name'],
    channelRows.map(([n]) => [n]),
  );
  console.log(`channels        ${channelIds.length}`);

  // 销售 25 人（按区域），客服 15 人
  const empRows: unknown[][] = [];
  const empMeta: { role: string; regionIdx: number }[] = [];
  const surnames = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴'];
  const given = ['伟', '芳', '娜', '磊', '洋', '静', '强', '敏', '杰', '婷', '涛', '雪'];
  for (let i = 0; i < 25; i++) {
    const ri = i % 5; // 海外不配销售
    empRows.push([`${pick(surnames)}${pick(given)}`, 'sales', regionId(ri), addDays(START, -int(60, 900))]);
    empMeta.push({ role: 'sales', regionIdx: ri });
  }
  for (let i = 0; i < 15; i++) {
    empRows.push([`${pick(surnames)}${pick(given)}`, 'support', int(0, 4) === 0 ? regionId(int(0, 5)) : null, addDays(START, -int(30, 700))]);
    empMeta.push({ role: 'support', regionIdx: 0 });
  }
  const empIds = await insertReturningIds('employees', ['name', 'role', 'regionId', 'hiredAt'], empRows);
  const salesIds = empIds.filter((_, i) => empMeta[i].role === 'sales');
  const supportIds = empIds.filter((_, i) => empMeta[i].role === 'support');
  console.log(`employees       ${empIds.length}（销售 ${salesIds.length} / 客服 ${supportIds.length}）`);

  // -------------------------------------------------- 客户

  // 2 万客户；30% 是企业客户（SaaS 订阅的主要来源）
  //
  // 为什么是 2 万而不是 5 千：客户数决定「复购率」这个指标的真假。
  // 5 千客户扛 2.5 万订单 = 平均每人 14 单，算出来复购率 90%，
  // 而真实电商是 30–40% —— 数字太漂亮反而说明数据是造的，评测答案也就没说服力了。
  const customerRows: unknown[][] = [];
  const customerType: string[] = [];
  const customerRegionIdx: number[] = [];
  const CUSTOMER_COUNT = 20000;
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const type = chance(0.3) ? 'business' : 'individual';
    const ri = weighted([0, 1, 2, 3, 4, 5], [32, 22, 20, 14, 9, 3]);
    const ci = weighted([0, 1, 2, 3, 4], [30, 25, 18, 12, 15]);
    // 注册时间：60% 在窗口内，40% 更早（老客户 → 复购和留存的故事）
    const signedUpAt = chance(0.6)
      ? randomDayIn(pick(MONTHS).start)
      : addDays(START, -int(30, 700));
    const name = type === 'business'
      ? `${pick(['恒信', '中新', '远景', '博远', '华创', '海联', '瑞达', '天工'])}${pick(['科技', '实业', '信息', '智能', '数据'])}有限公司`
      : `${pick(surnames)}${pick(given)}`;
    customerRows.push([name, type, `c${String(i + 1).padStart(5, '0')}@example.com`, regionId(ri), channelIds[ci], signedUpAt]);
    customerType.push(type);
    customerRegionIdx.push(ri);
  }
  const customerIds = await insertReturningIds(
    'customers',
    ['name', 'type', 'email', 'regionId', 'channelId', 'signedUpAt'],
    customerRows,
  );
  const businessCustomerIds = customerIds.filter((_, i) => customerType[i] === 'business');
  console.log(`customers       ${customerIds.length}（企业 ${businessCustomerIds.length}）`);

  // -------------------------------------------------- 商品

  const topCats = ['智能硬件', '办公设备', '配件耗材', '家居电子'];
  const subCats: Record<string, string[]> = {
    智能硬件: ['智能音箱', '智能穿戴', '智能门锁', '摄像头'],
    办公设备: ['打印机', '显示器', '会议设备'],
    配件耗材: ['线材', '电池', '打印耗材'],
    家居电子: ['照明', '小家电'],
  };
  const catRows: unknown[][] = [];
  for (const t of topCats) catRows.push([t, null]);
  const topCatIds = await insertReturningIds('categories', ['name', 'parentId'], catRows);
  const subCatRows: unknown[][] = [];
  const subParentIdx: number[] = [];
  topCats.forEach((t, i) => {
    for (const s of subCats[t]) {
      subCatRows.push([s, topCatIds[i]]);
      subParentIdx.push(i);
    }
  });
  const subCatIds = await insertReturningIds('categories', ['name', 'parentId'], subCatRows);
  console.log(`categories      ${topCatIds.length + subCatIds.length}`);

  const brands = ['星海', '云栖', '极簡', '北辰', '青松'];
  const productRows: unknown[][] = [];
  for (let i = 0; i < 500; i++) {
    const ci = int(0, subCatIds.length - 1);
    // 价格分布按品类：办公设备贵、耗材便宜（让"客单价"这个问题有真实分化）
    const base = subParentIdx[ci] === 1 ? gauss(2600, 900) : subParentIdx[ci] === 2 ? gauss(180, 80) : gauss(900, 400);
    productRows.push([
      `${pick(brands)}${pick(['Pro', 'Mini', 'Air', 'Max', 'Lite'])}${int(1, 9)}`,
      subCatIds[ci],
      pick(brands),
      Math.max(19, Math.round(base)),
      chance(0.9) ? 'active' : 'discontinued',
      addDays(START, -int(10, 800)),
    ]);
  }
  const productIds = await insertReturningIds(
    'products',
    ['name', 'categoryId', 'brand', 'basePrice', 'status', 'launchedAt'],
    productRows,
  );
  const productCategoryIdx = productRows.map((r) => subCatIds.indexOf(r[1] as number));
  const productPrice = productRows.map((r) => r[3] as number);

  // 每个商品 3 个规格
  const variantRows: unknown[][] = [];
  const variantProductIdx: number[] = [];
  const variantPrice: number[] = [];
  productIds.forEach((pid, pi) => {
    for (const spec of ['标准版', '升级版', '尊享版']) {
      const factor = spec === '标准版' ? 1 : spec === '升级版' ? 1.25 : 1.6;
      variantRows.push([pid, `SKU-${String(pi + 1).padStart(4, '0')}-${spec[0]}`, spec, Math.round(productPrice[pi] * factor)]);
      variantProductIdx.push(pi);
      variantPrice.push(Math.round(productPrice[pi] * factor));
    }
  });
  const variantIds = await insertReturningIds(
    'product_variants',
    ['productId', 'sku', 'name', 'price'],
    variantRows,
  );
  console.log(`products        ${productIds.length}（变体 ${variantIds.length}）`);

  // 仓库 5 个（海外一个）
  const whIds = await insertReturningIds(
    'warehouses',
    ['name', 'regionId'],
    ['上海仓', '北京仓', '广州仓', '成都仓', '新加坡仓'].map((n, i) => [n, regionId(Math.min(i, 4))]),
  );

  // 库存：每个变体在每个仓都有数（7500 行），偶尔缺货（让"库存紧张"这类问题有答案）
  const invRows: unknown[][] = [];
  for (const vid of variantIds) {
    for (const wid of whIds) {
      invRows.push([vid, wid, chance(0.08) ? int(0, 3) : int(10, 400), addDays(NOW, -int(0, 40))]);
    }
  }
  await insertMany('inventory', ['variantId', 'warehouseId', 'quantity', 'updatedAt'], invRows);
  console.log(`inventory       ${invRows.length}`);

  // -------------------------------------------------- 订单（核心）

  // 下单倾向：38% 的客户从不下单（"注册未转化"，真实电商就是这样）。
  // 下过单的人里，企业客户反复采购，个人客户大多只买一两次 ——
  // 用 pow(rand(),3) 把个人客户的权重压成右偏分布（多数接近 0，少数较高），
  // 简单地给所有人同一个区间会得到"人人买十单"的假数据。
  const orderCandidateIdx: number[] = [];
  const orderCandidateWeight: number[] = [];
  customerIds.forEach((_, idx) => {
    if (!chance(0.62)) return;
    orderCandidateIdx.push(idx);
    orderCandidateWeight.push(
      customerType[idx] === 'business' ? rand() * 2 + 1.2 : Math.pow(rand(), 3) * 2 + 0.05,
    );
  });

  const orderRows: unknown[][] = [];
  const orderMeta: { monthKey: string; customerIdx: number; total: number; items: unknown[][] }[] = [];
  // 目标订单量。这个数字要和客户数匹配：
  // 2 万客户 / 1.5 万单 → 买过的人平均 1.9 单，复购率落在 45% 左右（真实区间）；
  // 之前 2.5 万单时是 3.2 单/人、复购率 72%，一看就是造的数据。
  const totalBase = 12000;
  let orderSeq = 0;

  for (const month of MONTHS) {
    const count = Math.round((totalBase / MONTHS.length) * MONTH_WEIGHT[month.key]);
    for (let i = 0; i < count; i++) {
      const customerIdx = weighted(orderCandidateIdx, orderCandidateWeight);
      const orderedAt = randomDayIn(month.start);
      orderSeq += 1;

      // 每单 1~4 个商品
      const lineCount = weighted([1, 2, 3, 4], [45, 32, 16, 7]);
      const items: unknown[][] = [];
      let total = 0;
      const usedVariants = new Set<number>();
      for (let l = 0; l < lineCount; l++) {
        let vi = int(0, variantIds.length - 1);
        let guard = 0;
        while (usedVariants.has(vi) && guard++ < 10) vi = int(0, variantIds.length - 1);
        usedVariants.add(vi);
        const qty = weighted([1, 2, 3], [70, 22, 8]);
        const unitPrice = variantPrice[vi];
        const subtotal = unitPrice * qty;
        total += subtotal;
        items.push([vi, qty, unitPrice, subtotal]);
      }

      const discount = chance(0.18) ? Math.round(total * (chance(0.6) ? 0.1 : 0.05)) : 0;
      const shippingFee = total >= 199 ? 0 : 12;
      const payable = total - discount + shippingFee;

      // 状态：绝大多数 delivered；时间越近越可能还在途
      const daysAgo = Math.floor((NOW.getTime() - orderedAt.getTime()) / 86400_000);
      let status: string;
      if (chance(0.03)) status = 'cancelled';
      else if (daysAgo < 3) status = weighted(['paid', 'pending', 'shipped'], [50, 20, 30]);
      else if (daysAgo < 8) status = weighted(['shipped', 'delivered'], [40, 60]);
      else status = chance(0.02) ? 'refunded' : 'delivered';

      const paidAt = status === 'pending' || status === 'cancelled' ? null : addDays(orderedAt, int(0, 1));
      const salesRepId = chance(0.55) ? salesIds[int(0, salesIds.length - 1)] : null;

      orderRows.push([
        `SO${orderedAt.getUTCFullYear()}${String(orderedAt.getUTCMonth() + 1).padStart(2, '0')}${String(orderSeq).padStart(6, '0')}`,
        customerIds[customerIdx],
        channelIds[int(0, channelIds.length - 1)],
        salesRepId,
        status,
        orderedAt,
        paidAt,
        total + shippingFee,
        discount,
        shippingFee,
      ]);
      orderMeta.push({ monthKey: month.key, customerIdx, total: payable, items });
    }
  }

  const orderIds = await insertReturningIds(
    'orders',
    ['orderNo', 'customerId', 'channelId', 'salesRepId', 'status', 'orderedAt', 'paidAt', 'totalAmount', 'discountAmount', 'shippingFee'],
    orderRows,
  );
  console.log(`orders          ${orderIds.length}`);

  // 订单明细
  const itemRows: unknown[][] = [];
  const itemMeta: { orderIdx: number; variantIdx: number; subtotal: number }[] = [];
  orderIds.forEach((oid, oi) => {
    for (const it of orderMeta[oi].items) {
      const [vi, qty, unitPrice, subtotal] = it as [number, number, number, number];
      itemRows.push([oid, variantIds[vi], qty, unitPrice, subtotal]);
      itemMeta.push({ orderIdx: oi, variantIdx: vi, subtotal });
    }
  });
  await insertMany('order_items', ['orderId', 'variantId', 'quantity', 'unitPrice', 'subtotal'], itemRows);
  console.log(`order_items     ${itemRows.length}`);

  // 发货：delivered / shipped 状态的订单才有
  const shipRows: unknown[][] = [];
  orderIds.forEach((oid, oi) => {
    const st = orderRows[oi][4] as string;
    if (st !== 'delivered' && st !== 'shipped') return;
    const orderedAt = orderRows[oi][5] as Date;
    const shippedAt = addDays(orderedAt, int(1, 3));
    shipRows.push([
      oid,
      whIds[int(0, whIds.length - 1)],
      pick(['顺丰', '京东物流', '中通', '圆通']),
      `SF${int(100000000, 999999999)}`,
      shippedAt,
      st === 'delivered' ? addDays(shippedAt, int(1, 5)) : null,
    ]);
  });
  await insertMany('shipments', ['orderId', 'warehouseId', 'carrier', 'trackingNo', 'shippedAt', 'deliveredAt'], shipRows);
  console.log(`shipments       ${shipRows.length}`);

  // 退货：约 3% 的明细行，按品类有差异（耗材退得少、硬件退得多）
  const returnRows: unknown[][] = [];
  itemMeta.forEach((im, idx) => {
    const parentCat = subParentIdx[productCategoryIdx[variantProductIdx[im.variantIdx]]];
    const rate = parentCat === 0 ? 0.05 : parentCat === 1 ? 0.04 : parentCat === 2 ? 0.015 : 0.03;
    if (!chance(rate)) return;
    const orderedAt = orderRows[im.orderIdx][5] as Date;
    const requestedAt = addDays(orderedAt, int(3, 30));
    returnRows.push([
      // 用占位，稍后回填真实 item id
      idx,
      int(1, 2),
      pick(['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'late_delivery']),
      Math.round(im.subtotal * 0.8),
      requestedAt,
      chance(0.85) ? addDays(requestedAt, int(1, 7)) : null,
    ]);
  });
  if (returnRows.length) {
    // order_items 的 id 是自增且按插入顺序连续，取回真实 id 再插
    const r = await client.query<{ id: number }>('SELECT id FROM "order_items" ORDER BY id ASC');
    const itemIds = r.rows.map((x) => x.id);
    await insertMany(
      'returns',
      ['orderItemId', 'quantity', 'reason', 'refundAmount', 'requestedAt', 'resolvedAt'],
      returnRows.map((row) => [itemIds[row[0] as number], ...row.slice(1)]),
    );
  }
  console.log(`returns         ${returnRows.length}`);

  // 优惠券
  const couponRows: unknown[][] = [];
  for (let i = 0; i < 20; i++) {
    const type = chance(0.6) ? 'percent' : 'fixed';
    couponRows.push([
      `CP${2026}${String(i + 1).padStart(3, '0')}`,
      type,
      type === 'percent' ? int(5, 20) : int(20, 200),
      type === 'percent' ? int(100, 500) : int(200, 800),
      addDays(START, int(-30, 200)),
      addDays(NOW, int(-60, 120)),
      int(200, 5000),
    ]);
  }
  const couponIds = await insertReturningIds(
    'coupons',
    ['code', 'type', 'value', 'minSpend', 'validFrom', 'validTo', 'maxUses'],
    couponRows,
  );

  const redemptionRows: unknown[][] = [];
  orderIds.forEach((oid, oi) => {
    if (!chance(0.15)) return;
    const orderedAt = orderRows[oi][5] as Date;
    redemptionRows.push([
      couponIds[int(0, couponIds.length - 1)],
      oid,
      orderRows[oi][1],
      addDays(orderedAt, 0),
    ]);
  });
  await insertMany('coupon_redemptions', ['couponId', 'orderId', 'customerId', 'usedAt'], redemptionRows);
  console.log(`coupons         ${couponIds.length}（使用记录 ${redemptionRows.length}）`);

  // -------------------------------------------------- SaaS

  const planRows: unknown[][] = [
    ['基础版', 'basic', 299, 2990, 30, 10],
    ['专业版', 'pro', 899, 8990, 50, 50],
    ['企业版', 'enterprise', 2999, 29990, 80, 500],
  ];
  const planIds = await insertReturningIds(
    'plans',
    ['name', 'code', 'monthlyPrice', 'annualPrice', 'seatPrice', 'maxSeats'],
    planRows,
  );

  // 订阅：企业客户里 65% 订阅（这个比例是"跨线分析"的答案基础）
  const subscribing = businessCustomerIds.filter(() => chance(0.65));
  const subRows: unknown[][] = [];
  const subMeta: { planIdx: number; customerIdx: number; seats: number; monthlyValue: number }[] = [];
  for (const cid of subscribing) {
    const pi = weighted([0, 1, 2], [50, 35, 15]);
    const cycle = chance(0.4) ? 'annual' : 'monthly';
    const seats = int(3, pi === 2 ? 120 : pi === 1 ? 40 : 12);
    const startedAt = chance(0.7) ? randomDayIn(pick(MONTHS).start) : addDays(START, -int(30, 600));
    // 每月 3% 的概率已流失
    const canceled = chance(0.22);
    const status = canceled ? 'canceled' : chance(0.05) ? 'past_due' : chance(0.04) ? 'trialing' : 'active';
    const monthlyValue =
      (cycle === 'annual' ? planRows[pi][3] as number / 12 : planRows[pi][2] as number) +
      seats * (planRows[pi][4] as number);

    subRows.push([
      cid,
      planIds[pi],
      status,
      cycle,
      seats,
      startedAt,
      canceled ? addDays(startedAt, int(60, 300)) : null,
    ]);
    subMeta.push({ planIdx: pi, customerIdx: 0, seats, monthlyValue: Math.round(monthlyValue) });
  }
  const subIds = await insertReturningIds(
    'subscriptions',
    ['customerId', 'planId', 'status', 'billingCycle', 'seats', 'startedAt', 'canceledAt'],
    subRows,
  );
  console.log(`subscriptions   ${subIds.length}`);

  // 席位变更
  const seatRows: unknown[][] = [];
  subIds.forEach((sid, si) => {
    const changes = int(0, 4);
    let seats = subMeta[si].seats;
    for (let i = 0; i < changes; i++) {
      const delta = chance(0.7) ? int(1, 5) : -int(1, 3);
      seats = Math.max(1, seats + delta);
      seatRows.push([sid, delta, seats, addDays(subRows[si][5] as Date, int(30, 300))]);
    }
  });
  await insertMany('subscription_seat_changes', ['subscriptionId', 'delta', 'seatsAfter', 'changedAt'], seatRows);
  console.log(`seat_changes    ${seatRows.length}`);

  // 账单：每个订阅按计费周期生成，最多到 2026-10
  const invoiceRows: unknown[][] = [];
  const invoiceMeta: { amount: number; status: string; issuedAt: Date }[] = [];
  subIds.forEach((sid, si) => {
    const startedAt = subRows[si][5] as Date;
    const cycle = subRows[si][3] as string;
    const monthly = subMeta[si].monthlyValue;
    const stepDays = cycle === 'annual' ? 365 : 30;
    let cursor = startedAt;
    let n = 0;
    while (cursor < NOW && n < 24) {
      const amount = cycle === 'annual' ? monthly * 12 : monthly;
      const dueAt = addDays(cursor, 7);
      const status = dueAt < NOW ? (chance(0.92) ? 'paid' : 'open') : 'open';
      invoiceRows.push([sid, cursor, addDays(cursor, stepDays), amount, status, cursor, dueAt]);
      invoiceMeta.push({ amount, status, issuedAt: cursor });
      cursor = addDays(cursor, stepDays);
      n += 1;
    }
  });
  const invoiceIds = await insertReturningIds(
    'invoices',
    ['subscriptionId', 'periodStart', 'periodEnd', 'amount', 'status', 'issuedAt', 'dueAt'],
    invoiceRows,
  );
  console.log(`invoices        ${invoiceIds.length}`);

  const payRows: unknown[][] = [];
  invoiceIds.forEach((iid, ii) => {
    const meta = invoiceMeta[ii];
    if (meta.status !== 'paid') return;
    const paidAt = addDays(meta.issuedAt, int(0, 6));
    payRows.push([
      iid,
      meta.amount,
      weighted(['alipay', 'wechat', 'bank_transfer', 'card'], [40, 25, 25, 10]),
      chance(0.98) ? 'succeeded' : 'failed',
      paidAt,
    ]);
  });
  await insertMany('payments', ['invoiceId', 'amount', 'method', 'status', 'paidAt'], payRows);
  console.log(`payments        ${payRows.length}`);

  // -------------------------------------------------- 工单

  const ticketRows: unknown[][] = [];
  for (let i = 0; i < 3000; i++) {
    const openedAt = randomDayIn(pick(MONTHS).start);
    const cat = weighted(['billing', 'technical', 'shipping', 'product', 'account'], [20, 30, 22, 15, 13]);
    const prio = weighted(['low', 'normal', 'high', 'urgent'], [25, 50, 18, 7]);
    // 高优先级关得快 —— 让"解决时长"这个问题有分化
    const resolveDays = prio === 'urgent' ? int(0, 2) : prio === 'high' ? int(0, 4) : int(1, 12);
    const closed = chance(0.9);
    const closedAt = closed ? addDays(openedAt, resolveDays) : null;
    ticketRows.push([
      customerIds[int(0, customerIds.length - 1)],
      chance(0.7) ? supportIds[int(0, supportIds.length - 1)] : null,
      `${cat === 'billing' ? '账单问题' : cat === 'technical' ? '设备无法连接' : cat === 'shipping' ? '物流查询' : cat === 'product' ? '产品咨询' : '账号问题'}-${int(1000, 9999)}`,
      cat,
      prio,
      closed ? 'closed' : chance(0.5) ? 'pending' : 'open',
      openedAt,
      closedAt,
    ]);
  }
  await insertMany('support_tickets', ['customerId', 'assignedToId', 'subject', 'category', 'priority', 'status', 'openedAt', 'closedAt'], ticketRows);
  console.log(`support_tickets ${ticketRows.length}`);

  // -------------------------------------------------- 收尾统计

  const stats = await client.query<{ table: string; rows: string }>(`
    SELECT 'orders' AS "table", count(*)::text AS rows FROM orders
    UNION ALL SELECT 'customers', count(*)::text FROM customers
    UNION ALL SELECT 'customers_with_2plus_orders', count(*)::text FROM (
      SELECT customer_id FROM orders GROUP BY 1 HAVING count(*) >= 2
    ) x
    UNION ALL SELECT 'hw_buyers', count(*)::text FROM (
      SELECT DISTINCT customer_id FROM orders
    ) x
    UNION ALL SELECT 'hw_buyers_with_sub', count(*)::text FROM (
      SELECT DISTINCT o.customer_id FROM orders o
      JOIN subscriptions s ON s.customer_id = o.customer_id
    ) x
  `);

  console.log('\n===== 数据里的故事（评测集的答案基础）=====');
  for (const row of stats.rows) console.log(`  ${row.table.padEnd(26)} ${row.rows}`);

  const gmv = await client.query<{ month: string; gmv: string }>(`
    SELECT to_char(ordered_at, 'YYYY-MM') AS month, round(sum(total_amount - discount_amount))::text AS gmv
    FROM orders WHERE status NOT IN ('cancelled') GROUP BY 1 ORDER BY 1
  `);
  console.log('\n  月度 GMV：');
  for (const row of gmv.rows) console.log(`    ${row.month}  ${Number(row.gmv).toLocaleString()}`);

  await client.end();
  console.log('\n完成。');
}

main().catch(async (e) => {
  console.error('FAIL', e);
  await client.end().catch(() => {});
  process.exit(1);
});
