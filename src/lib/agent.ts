/**
 * 数据问答 Agent 的核心：工具集 + 循环。
 *
 * 为什么用 `ToolLoopAgent` 而不是自己写状态机（和项目 #1 的选型理由对照）：
 *   项目 #1 用 `streamText` + `stopWhen`，因为只有 1 个工具，"循环"其实就是
 *   "调一次工具再生成"两拍。这里有 6 个工具、要处理 SQL 报错重试、要做写操作审批，
 *   自己维护的状态机会长到 300 行以上，而且每加一个工具就要改一遍 —— 那才是真正的成本。
 *
 * ⚠️ thinking 参数：DeepSeek 是推理模型，不关会烧思考 token。
 *   它不在 @ai-sdk/openai 的 providerOptions schema 里（严格 zod，未知键被剥），
 *   唯一通道是 createOpenAI 的自定义 fetch 中间件。这是项目 #1 spike 阶段
 *   读包源码踩出来的，这里照搬。
 */

import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, ToolLoopAgent, tool } from 'ai';

import {
  describeTableColumns,
  getTableRowCounts,
  SqlExecutionError,
  SqlRejected,
  runReadOnlyQuery,
  type QueryResult,
} from './agent-db';
import PROMPT from './agent-prompt.json';
import { TABLE_DOCS, TABLE_DOC_MAP } from './schema-docs';

/** 一次问答最多几步。一个有代表性的分析是：列表 → 看结构 → 查 → 改 → 查 → 作答 = 6 步。 */
export const MAX_STEPS = 10;

/** 同一条 SQL 连续失败的上限：超过就停，别让模型在同一个坑里烧 token。 */
const MAX_ATTEMPTS_PER_TURN = 6;

// ---------------------------------------------------------------- provider

type ProviderSettings = Parameters<typeof createOpenAI>[0];
type FetchFn = NonNullable<ProviderSettings>['fetch'];

/** 给每个请求体注入 DeepSeek 私有的 thinking 开关。 */
const INJECT_THINKING: FetchFn = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  body.thinking = { type: 'disabled' };
  return fetch(url, { ...init, body: JSON.stringify(body) });
};

type Provider = ReturnType<typeof createOpenAI>;

/** dev 热重载会反复执行本模块，provider 挂 globalThis 避免泄漏客户端。 */
const globalForProvider = globalThis as unknown as { __dataAgentProvider?: Provider };

function getProvider(): Provider {
  if (globalForProvider.__dataAgentProvider) return globalForProvider.__dataAgentProvider;

  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!apiKey) throw new Error('缺少 LLM_API_KEY，检查 .env.local');

  const provider = createOpenAI({
    apiKey,
    baseURL: baseUrl,
    fetch: INJECT_THINKING,
  });
  globalForProvider.__dataAgentProvider = provider;
  return provider;
}

// ---------------------------------------------------------------- 结果格式化

/**
 * 把查询结果转成给模型看的文本。
 *
 * 三个刻意的限制：
 *   · 最多给模型 50 行（UI 可以看 1000 行）—— 模型不需要看完 1000 行才能下结论，
 *     但"有多少行"这个事实必须给它，否则它会以为只有 50 行。
 *   · null 显式写成 `NULL`，不写成空 —— 空字符串和"没有值"在统计上完全不同。
 *   · 数字不加千分位 —— 加了模型算 subtraction 时会出错。
 */
function formatForModel(r: QueryResult): string {
  if (!r.rows.length) {
    return '查询成功，但返回 0 行。可能是筛选条件过严，或者这段时间确实没有数据。';
  }

  const shown = r.rows.slice(0, 50);
  const header = `返回 ${r.rowCount} 行${r.truncated ? `（已截断，实际更多）` : ''}，耗时 ${r.elapsedMs}ms。`;

  const lines = [
    header,
    '',
    '| ' + r.columns.join(' | ') + ' |',
    '| ' + r.columns.map(() => '---').join(' | ') + ' |',
    ...shown.map((row) =>
      '| ' + r.columns.map((c) => (row[c] === null ? 'NULL' : String(row[c]))).join(' | ') + ' |',
    ),
  ];

  if (r.rows.length > shown.length) {
    lines.push('', `（只显示前 ${shown.length} 行。需要完整数据请加聚合或筛选。）`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 工具

/** 用 jsonSchema 而不是 zod：与项目 #1 的写法保持一致，也少一层依赖转换。 */
function makeTools() {
  /** 每次问答的尝试计数，用来防"同一个坑里反复烧 token"。 */
  const state = { sqlAttempts: 0, lastError: '' };

  const listTables = tool({
    description:
      '列出数据库里所有表、各自用途和**当前行数**（21 张，一次全给）。' +
      '不确定有哪些数据时先调这个 —— 它比逐张 describeTable 便宜得多，' +
      '行数还能帮你判断该不该先做聚合。',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      required: [],
    }),
    execute: async () => {
      // 行数现查：写死在文档里必然过时，而过时的数字不会报错、只会答错
      const counts = await getTableRowCounts(TABLE_DOCS.map((d) => d.table));
      return TABLE_DOCS.map((d) => {
        const n = counts.get(d.table);
        const size = n === undefined ? '' : `（${n} 行）`;
        return `${d.table}${size} — ${d.summary}`;
      }).join('\n');
    },
  });

  const describeTable = tool({
    description:
      '查一张表的完整列定义（列名、类型、是否可空）。' +
      '写 SQL 前如果不确定列名，**必须**用它确认 —— 真实列名是 snake_case，凭猜测写会报错。',
    inputSchema: jsonSchema<{ table: string }>({
      type: 'object',
      properties: {
        table: { type: 'string', description: '表名，必须是 listTables 返回过的名字' },
      },
      required: ['table'],
    }),
    execute: async ({ table }: { table: string }) => {
      const doc = TABLE_DOC_MAP.get(table);
      const cols = await describeTableColumns(table, TABLE_DOC_MAP.keys());
      const lines = [
        `${table} — ${doc?.summary ?? ''}`,
        '',
        '| 列名 | 类型 | 可空 |',
        '| --- | --- | --- |',
        ...cols.map((c) => `| ${c.column} | ${c.type} | ${c.nullable ? '是' : '否'} |`),
      ];
      if (doc?.pitfall) lines.push('', `⚠️ ${doc.pitfall}`);
      return lines.join('\n');
    },
  });

  const runSql = tool({
    description:
      '执行一条只读 SQL 查询并返回结果。只支持单条 SELECT 语句（CTE 可用），' +
      '最多返回 1000 行，超时 10 秒。报错信息会原样返回，你可以据此修正 SQL 重试。',
    inputSchema: jsonSchema<{ sql: string }>({
      type: 'object',
      properties: {
        sql: { type: 'string', description: '一条 PostgreSQL SELECT 语句，不要带分号结尾' },
      },
      required: ['sql'],
    }),
    /**
     * 关键设计：**报错不抛异常，转成文本返回**。
     *
     * SDK 会把抛出的异常当成"工具坏了"回传给模型，模型可能去解释"数据库服务故障"——
     * 那是误导用户，而真实原因是 SQL 写错了，模型完全有能力自己修。
     * 项目 #1 在检索预算上也踩过同一个点。
     */
    execute: async ({ sql }: { sql: string }) => {
      state.sqlAttempts += 1;
      if (state.sqlAttempts > MAX_ATTEMPTS_PER_TURN) {
        return (
          `本轮已经失败 ${MAX_ATTEMPTS_PER_TURN} 次，停止尝试。` +
          '请基于已有信息作答，并如实说明哪部分没能查到。'
        );
      }

      try {
        const result = await runReadOnlyQuery(sql);
        state.lastError = '';
        return formatForModel(result);
      } catch (e) {
        if (e instanceof SqlRejected) {
          return `这条 SQL 没被执行：${e.message}。请修改后重试。`;
        }
        if (e instanceof SqlExecutionError) {
          // 数据库的报错原样给模型 —— 它需要 position 和 hint 才能定位到具体位置
          const parts = [`SQL 执行失败：${e.message}`];
          if (e.code) parts.push(`错误码：${e.code}`);
          if (e.hint) parts.push(`提示：${e.hint}`);
          if (e.position) parts.push(`出错位置（第 ${e.position} 个字符附近）`);
          state.lastError = e.message;
          return parts.join('\n');
        }
        throw e;
      }
    },
  });

  return { listTables, describeTable, runSql };
}

// ---------------------------------------------------------------- agent

/**
 * 每次请求新建一个 agent 实例。
 *
 * 不挂全局单例的原因：`makeTools()` 里的 state（尝试计数）是**每轮对话独立**的，
 * 复用实例会让上一轮的失败次数算到下一轮头上 —— 这种 bug 极难复现。
 * provider 是单例（贵），agent 是轻量的（就是几个对象的组合），每次 new 没问题。
 */
export function createDataAgent() {
  return new ToolLoopAgent({
    model: getProvider()(process.env.LLM_MODEL || 'deepseek-flash'),
    // ToolLoopAgent 里这个字段叫 instructions（不是 streamText 的 system）——
    // 语义相同，只是 Agent 抽象把"给模型的行为说明"独立命名了。
    instructions: PROMPT.system,
    tools: makeTools(),
    // 步数上限 = 账单上限。没有上限的 agent 循环 = 没有上限的成本。
    stopWhen: ({ steps }) => steps.length >= MAX_STEPS,
  });
}

export type { QueryResult };
