/**
 * Agent 执行 SQL 的**唯一**入口。
 *
 * 安全模型四层（见 docs/ACCEPTANCE-W1.md 第 3 节），这里实现第 2、3 层：
 *   1. 数据库账号只读     ← 在数据库里配（scripts/setup-ro-role.mts），代码管不着
 *   2. 事务强制 READ ONLY ← 这里，BEGIN TRANSACTION READ ONLY
 *   3. 超时 + 行数上限     ← 这里
 *   4. prompt 约束         ← 不属于本文件，且**不作为安全依赖**
 *
 * 为什么第 2 层不能省（账号已经是只读了）：账号权限是"配一次、可能配错"的，
 * 而 READ ONLY 事务是"每次请求都声明一次"的。前者错了没人知道，后者错了当场报错。
 * 安全设计里，能把假设变成运行时断言的，就不要只写在配置里。
 *
 * 这个连接**不碰应用表**（saved_queries / schema_docs 走 src/lib/db.ts 的读写连接）——
 * Agent 的能力边界和应用的写入能力是两条独立通道，混在一起就说不清"谁能写什么"。
 */

import pg from 'pg';

import { NUMERIC_TYPE_OIDS } from './column-totals';

const { Pool } = pg;

/** 单次查询最多返回行数。超过就截断并告知模型（让它自己加聚合或过滤）。 */
export const MAX_ROWS = 1000;

/** 单条 SQL 的硬超时（毫秒）。防全表扫描拖垮数据库。 */
const STATEMENT_TIMEOUT_MS = 10_000;

/** SQL 文本长度上限：正常分析查询到不了这个量级，超了基本是模型跑飞了。 */
const MAX_SQL_LENGTH = 4000;

/** SQL 被我们自己拦下的原因（不是数据库报错 —— 那个要原样喂回模型让它自己修）。 */
export class SqlRejected extends Error {
  constructor(
    message: string,
    public readonly kind: 'too_long' | 'multi_statement' | 'empty',
  ) {
    super(message);
    this.name = 'SqlRejected';
  }
}

/** 数据库执行报错。message 原样给模型看，这是"自己修"的输入。 */
export class SqlExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly hint: string | undefined,
    public readonly position: number | undefined,
  ) {
    super(message);
    this.name = 'SqlExecutionError';
  }
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  const connectionString = process.env.AGENT_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      '缺少 AGENT_DATABASE_URL。这是只读账号的连接串，不能和 DATABASE_URL 共用 —— ' +
        '共用了就等于把安全交给 prompt 自觉。跑 scripts/setup-ro-role.mts 创建。',
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 10_000,
      // 服务端级超时：即使我们的 Promise 超时逻辑失效，PG 自己也会掐断
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: 15_000,
    });
  }
  return pool;
}

/**
 * 多语句检测。
 *
 * ⚠️ 这不是安全边界，是**语义边界**：多语句执行时"结果取哪一条"是未定义的，
 * 让模型看到不确定的结果比直接拒绝更糟。真正的安全在第 1、2 层。
 * 所以这里用朴素正则就够了，不追求穷尽所有 SQL 方言的转义规则。
 */
function hasMultipleStatements(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  return stripped.replace(/;\s*$/, '').includes(';');
}

export type QueryResult = {
  columns: string[];
  /**
   * 数据库告知是数值类型的列（来自 `result.fields[].dataTypeID`，不是猜的）。
   *
   * 存在的理由：给模型算「列合计」时不能靠值长什么样判断 —— `String` 列里全是
   * 数字和 `numeric` 列在 JS 里长得一模一样。类型的唯一可信来源是数据库自己。
   */
  numericColumns: string[];
  /** 行数据，已转成 JSON 安全的值（Date → ISO 字符串，BigInt → number/string）。 */
  rows: Record<string, unknown>[];
  /** 实际返回行数（截断后）。 */
  rowCount: number;
  /** 是否因超过 MAX_ROWS 被截断。 */
  truncated: boolean;
  elapsedMs: number;
};

/** 把 PG 返回的各种类型转成 JSON 安全、且模型容易读的值。 */
function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && !Array.isArray(v) && 'toString' in v) {
    // Decimal / numeric 在 node-postgres 里是字符串，走到这里的情况一并转字符串
    return String(v);
  }
  return v;
}

/**
 * 执行一条只读查询。
 *
 * 两个包装：
 *   · 外层 `SELECT * FROM (...) LIMIT n` —— 无论模型写什么，返回行数都有硬上限。
 *     内层的 ORDER BY / GROUP BY / LIMIT 语义不变（子查询先执行）。
 *   · `BEGIN TRANSACTION READ ONLY` —— 即使账号权限配错，写操作也会被引擎拒绝。
 */
export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  const trimmed = sql.trim();
  if (!trimmed) throw new SqlRejected('SQL 为空', 'empty');
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new SqlRejected(`SQL 太长（${trimmed.length} 字符，上限 ${MAX_SQL_LENGTH}）`, 'too_long');
  }
  if (hasMultipleStatements(trimmed)) {
    throw new SqlRejected('一次只能执行一条语句（检测到分号分隔的多条）', 'multi_statement');
  }

  const body = trimmed.replace(/;\s*$/, '');
  const wrapped = `SELECT * FROM (\n${body}\n) AS _agent_result LIMIT ${MAX_ROWS + 1}`;

  const started = Date.now();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    let result: pg.QueryResult<Record<string, unknown>>;
    try {
      result = await client.query(wrapped);
    } catch (e) {
      const err = e as { message?: string; code?: string; hint?: string; position?: string };
      throw new SqlExecutionError(
        err.message ?? '未知数据库错误',
        err.code,
        err.hint,
        err.position ? Number(err.position) : undefined,
      );
    } finally {
      /**
       * ⚠️ 无论成功还是报错，都必须结束事务。
       *
       * 这里漏掉 rollback 的后果实测过（W1 冒烟）：一条 SQL 报错后事务进入 aborted 状态，
       * 连接带着 aborted 事务回到池里，**之后所有复用这条连接的查询都会报
       * "current transaction is aborted"** —— 而且看起来像是 SQL 写错了，
       * 模型会一直改 SQL 而不 stop，把步数预算烧光。
       *
       * 这是"答案对、过程有病"的典型：最终数字是对的（第一次查询成功了），
       * 所以只看答案的 UI 永远发现不了它。可观测性抓到的第一个真 bug。
       */
      await client.query('ROLLBACK').catch(() => {
        // 连接本身断了也会抛，这时 ROLLBACK 已无意义 —— 池会丢弃这条连接
      });
    }

    const truncated = result.rows.length > MAX_ROWS;
    const rows = (truncated ? result.rows.slice(0, MAX_ROWS) : result.rows).map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
      return out;
    });

    return {
      columns: result.fields.map((f) => f.name),
      numericColumns: result.fields
        .filter((f) => NUMERIC_TYPE_OIDS.has(f.dataTypeID))
        .map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      elapsedMs: Date.now() - started,
    };
  } finally {
    client.release();
  }
}

/**
 * 查某张表的真实列定义。
 *
 * 为什么不把列名写死在 schema-docs.ts 里：那份文档会漂移 ——
 * 加了一列、改了个类型，文档不会自动更新，而模型会照着过时的文档写出报错的 SQL。
 * information_schema 是**唯一不会骗人的来源**，每次现查（几毫秒）。
 *
 * `table` 来自模型，**必须白名单校验**再拼进查询 —— 这里虽然用了参数化，
 * 但表名是标识符不能参数化，所以先比对白名单，不在里面直接返回空。
 */
export async function describeTableColumns(
  table: string,
  allowedTables: Iterable<string>,
): Promise<{ column: string; type: string; nullable: boolean }[]> {
  const allowed = new Set(allowedTables);
  if (!allowed.has(table)) {
    throw new SqlRejected(`没有这张表：${table}`, 'empty');
  }
  const client = await getPool().connect();
  try {
    const r = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [table],
    );
    return r.rows.map((row) => ({
      column: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
    }));
  } finally {
    client.release();
  }
}

/**
 * 每张表当前有多少行。
 *
 * 为什么不写死在文档里：写死的数字必然过时。seed 从 2.5 万单调到 1.5 万单之后，
 * 文档里还写着"2 万单"—— 模型会拿它当事实用，而**它不会报错**，只会答错。
 * 这是本项目最想避免的那类缺陷：静默、且看起来完全正常。
 *
 * 用一条 UNION ALL 查询而不是 21 次往返（Neon 在新加坡，每次往返 50ms）。
 * 表名来自 TABLE_DOCS 白名单，不是模型输入。
 */
export async function getTableRowCounts(tables: readonly string[]): Promise<Map<string, number>> {
  if (!tables.length) return new Map();
  const parts = tables.map((t) => `SELECT '${t}' AS t, count(*)::bigint AS n FROM "${t}"`);
  const client = await getPool().connect();
  try {
    const r = await client.query<{ t: string; n: string }>(parts.join(' UNION ALL '));
    const map = new Map<string, number>();
    for (const row of r.rows) map.set(row.t, Number(row.n));
    return map;
  } finally {
    client.release();
  }
}

/**
 * 只读角色的权限自检：对业务表发起一次「不改任何行」的写，必须在权限检查阶段就被拒。
 *
 * 为什么不用 CREATE TEMP TABLE 试探：PostgreSQL 默认给 PUBLIC 建临时表的权限，
 * 只读账号照样能建 —— 探针会误报"权限配错了"，其实配对了。
 * 真正的边界是「能不能改业务表」，就测这个。
 *
 * `WHERE false` 不修改任何数据，但权限检查发生在执行前，所以 0 行也会被拒。
 */
export async function assertReadOnly(): Promise<{ ok: boolean; detail: string }> {
  const client = await getPool().connect();
  try {
    try {
      await client.query('UPDATE customers SET name = name WHERE false');
      return { ok: false, detail: '只读账号能 UPDATE 业务表 —— 权限配错了，立刻停下' };
    } catch (e) {
      const msg = (e as { message?: string }).message ?? '';
      if (/permission denied/i.test(msg)) {
        return { ok: true, detail: '对业务表的写入被拒绝（符合预期）' };
      }
      // 不是权限错误（比如表不存在）—— 说明环境本身有问题，也要暴露出来
      return { ok: false, detail: `探测时遇到非权限错误：${msg}` };
    }
  } finally {
    client.release();
  }
}
