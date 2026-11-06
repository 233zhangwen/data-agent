/**
 * 创建 Agent 专用的**只读数据库角色**，并把连接串写回 .env.local。
 *
 * 这是安全模型的第一层（docs/ACCEPTANCE-W1.md 第 3 节）：
 * 模型再怎么被诱导（"帮我把订单表清空"）也改不了数据 —— 因为这个角色没有那个权限。
 *
 * 反过来做（用读写账号 + prompt 说"不要删数据"）是最常见的错误：
 * 那不是安全措施，是许愿。prompt 是语言层的约定，模型换一版、温度调高一点就失效；
 * 而 GRANT 是数据库引擎层的，绕不过。
 *
 * 权限边界：
 *   ✅ 21 张业务表：SELECT
 *   ❌ schema_docs / saved_queries：不给 —— 那是应用状态，不是"被分析的公司"的数据
 *   ❌ 任何 INSERT / UPDATE / DELETE / DDL
 *
 * 幂等：角色已存在就 ALTER 密码 + 重新授权，可以反复跑。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

/** 21 张业务表。与 src/lib/schema-docs.ts 的 TABLE_DOCS 必须一致。 */
const BUSINESS_TABLES = [
  'regions', 'channels', 'employees',
  'customers', 'categories', 'products', 'product_variants', 'warehouses',
  'inventory', 'orders', 'order_items', 'shipments', 'returns',
  'coupons', 'coupon_redemptions',
  'plans', 'subscriptions', 'subscription_seat_changes', 'invoices', 'payments',
  'support_tickets',
];

const ROLE = 'data_agent_ro';

function readEnv(): string {
  return readFileSync('.env.local', 'utf8');
}

function envValue(env: string, key: string): string {
  const m = env.match(new RegExp(`^${key}="?([^"\\n]+)"?`, 'm'));
  if (!m) throw new Error(`.env.local 缺少 ${key}`);
  return m[1];
}

async function main() {
  const env = readEnv();
  const directUrl = envValue(env, 'DIRECT_URL');

  const parsed = new URL(directUrl);
  const dbName = parsed.pathname.replace(/^\//, '');
  const host = parsed.hostname;

  const client = new Client({ connectionString: directUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 复用已有密码（重跑时不改变连接串）；没有就生成一个
  const existing = env.match(/^AGENT_DATABASE_URL="?([^"\n]+)"?/m)?.[1] ?? '';
  let password = '';
  if (existing) {
    try {
      password = decodeURIComponent(new URL(existing).password);
    } catch {
      password = '';
    }
  }
  if (!password) password = randomBytes(18).toString('base64url');

  console.log(`角色：${ROLE}`);
  console.log(`库：${dbName} @ ${host}`);

  // 1. 建角色（或改密码）
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE "${ROLE}" LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
    console.log('  ✓ 角色已创建');
  } else {
    await client.query(`ALTER ROLE "${ROLE}" LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
    console.log('  ✓ 角色已存在，密码已重置');
  }

  // 2. 只给「连上来 + 看得见 schema」的权限
  await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${ROLE}"`);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
  // 撤销可能存在的历史授权，保证这次是干净状态
  await client.query(`REVOKE ALL ON SCHEMA public FROM "${ROLE}"`);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
  console.log('  ✓ 已授予 CONNECT + USAGE ON SCHEMA public');

  // 3. 只对 21 张业务表给 SELECT —— 显式列名，不用 ALL TABLES
  //    理由：ALL TABLES 会把将来新增的表（尤其应用表）也自动放行，
  //    而"新增一张表就悄悄多一个攻击面"正是最难发现的那种问题。
  for (const table of BUSINESS_TABLES) {
    await client.query(`GRANT SELECT ON TABLE "${table}" TO "${ROLE}"`);
  }
  console.log(`  ✓ 已授予 ${BUSINESS_TABLES.length} 张业务表的 SELECT`);

  // 4. 应用表明确不给
  for (const table of ['schema_docs', 'saved_queries']) {
    await client.query(`REVOKE ALL ON TABLE "${table}" FROM "${ROLE}"`);
  }
  console.log('  ✓ 已确认应用表（schema_docs / saved_queries）不可读');

  // 5. 序列不用给（只读不需要 nextval）

  // 6. 验证：用新角色真的连一次，确认能查业务表、不能查应用表、不能写
  const roUrl = new URL(directUrl);
  roUrl.username = ROLE;
  roUrl.password = password;
  const roClient = new Client({ connectionString: roUrl.toString(), ssl: { rejectUnauthorized: false } });
  await roClient.connect();

  const canRead = await roClient
    .query('SELECT count(*)::int AS n FROM orders')
    .then((r) => `orders 可读（${r.rows[0].n} 行）`)
    .catch((e) => `orders 不可读：${e.message}`);

  const cannotWrite = await roClient
    .query('UPDATE orders SET status = status WHERE false')
    .then(() => '❌ 竟然能写！')
    .catch((e) => (/permission denied/i.test(e.message) ? '✓ 写入被拒绝' : `? ${e.message}`));

  const cannotReadApp = await roClient
    .query('SELECT count(*) FROM saved_queries')
    .then(() => '❌ 能读应用表！')
    .catch((e) => (/permission denied/i.test(e.message) ? '✓ 应用表被拒绝' : `? ${e.message}`));

  console.log('\n验证：');
  console.log('  ·', canRead);
  console.log('  ·', cannotWrite);
  console.log('  ·', cannotReadApp);

  await roClient.end();
  await client.end();

  // 7. 写回 .env.local
  const newUrl = roUrl.toString();
  let next: string;
  if (/^AGENT_DATABASE_URL=/m.test(env)) {
    next = env.replace(/^AGENT_DATABASE_URL=.*$/m, `AGENT_DATABASE_URL="${newUrl}"`);
  } else {
    next = env + `\nAGENT_DATABASE_URL="${newUrl}"\n`;
  }
  // 覆盖写可能被沙箱挡住，重试几次
  let written = false;
  for (let i = 0; i < 6 && !written; i++) {
    try {
      writeFileSync('.env.local', next);
      written = true;
    } catch {
      /* retry */
    }
  }
  console.log(`\n.env.local ${written ? '已更新' : '写入失败（请手动填 AGENT_DATABASE_URL）'}`);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
