/**
 * 数据问答 Agent 的核心：工具集 + 循环 + 死循环防护 + 测试注入点。
 *
 * 为什么用 `ToolLoopAgent` 而不是自己写状态机（和项目 #1 的选型理由对照）：
 *   项目 #1 用 `streamText` + `stopWhen`，因为只有 1 个工具，"循环"其实就是
 *   "调一次工具再生成"两拍。这里有 6 个工具、要处理 SQL 报错重试、要做写操作审批，
 *   自己维护的状态机会长到 300 行以上，而且每加一个工具就要改一遍 —— 那才是真正的成本。
 *
 * ⚠️ thinking 参数（W2 C15 实测修订）：deepseek-flash 当前**无法关闭思考**——
 *   thinking:{type:'disabled'} 与 reasoning_effort:'none' 都注入到了请求体
 *   （eval/probe-inject.eval.ts 验证），但服务端照常返回 reasoning tokens。
 *   注入保留（端点将来恢复尊重该参数时自动生效），成本控制实际靠 MAX_STEPS。
 *   注入走 createOpenAI 的自定义 fetch 中间件：参数不在 @ai-sdk/openai 的
 *   providerOptions schema 里（严格 zod，未知键被剥），这是项目 #1 spike 踩出来的。
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
import { CALC_DESCRIPTION, calculate, type CalcOp } from './calc';
import { buildChartSpec, chartErrorForModel, type ChartSpec } from './chart';
import {
  createLoopGuard,
  L2_SAME_ERROR_AT,
  l1Notice,
  l2Notice,
  L3_NOTICE,
} from './loop-guard';
import { createProposal, SaveQueryRejected } from './save-query';
import { rankTables } from './schema-search';
import { TABLE_DOCS, TABLE_DOC_MAP } from './schema-docs';
import { planStep } from './step-budget';

/**
 * 一次问答最多几步（= 最多几次模型调用）。有代表性的分析是：
 * 列表 → 看结构 → 查 → 改 → 查 → 作答 = 6 步。
 *
 * 注意最后一格**不给工具**（step-budget.ts）：实际可用工具步数 9 步 + 1 步作答。
 */
export const MAX_STEPS = 10;

/** 同一条 SQL 连续失败的上限：超过就停，别让模型在同一个坑里烧 token。 */
const MAX_ATTEMPTS_PER_TURN = 6;

// ---------------------------------------------------------------- provider

type ProviderSettings = Parameters<typeof createOpenAI>[0];
type FetchFn = NonNullable<ProviderSettings>['fetch'];

/** 给每个请求体注入 DeepSeek 私有的 thinking 开关。评测要能开关对比（C15）。 */
function makeFetchWithThinking(thinking: 'disabled' | 'enabled'): FetchFn {
  return async (url, init) => {
    const body = JSON.parse(String(init?.body));
    body.thinking = { type: thinking };
    return fetch(url, { ...init, body: JSON.stringify(body) });
  };
}

type Provider = ReturnType<typeof createOpenAI>;

/** dev 热重载会反复执行本模块，provider 挂 globalThis 避免泄漏客户端。 */
const globalForProvider = globalThis as unknown as {
  __dataAgentProvider?: Partial<Record<'disabled' | 'enabled', Provider>>;
};

export function getProvider(thinking: 'disabled' | 'enabled'): Provider {
  const cache = (globalForProvider.__dataAgentProvider ??= {});
  const cached = cache[thinking];
  if (cached) return cached;

  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!apiKey) throw new Error('缺少 LLM_API_KEY，检查 .env.local');

  const provider = createOpenAI({
    apiKey,
    baseURL: baseUrl,
    fetch: makeFetchWithThinking(thinking),
  });
  cache[thinking] = provider;
  return provider;
}

/** 同一个模型实例给两条路径用：主循环（ToolLoopAgent）和兜底收口（generateText）。 */
export function getChatModel(thinking: 'disabled' | 'enabled' = 'disabled') {
  return getProvider(thinking)(process.env.LLM_MODEL || 'deepseek-flash');
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

/** 测试注入点：只在评测里构造，产品路径永远不传（docs/ACCEPTANCE-W2.md 3.1）。 */
export type Faults = {
  /** 文档漂移：describeTable 显示一个不存在但合理的列，诱导模型写出必然报错的 SQL。 */
  driftColumns?: { table: string; column: string }[];
  /** 文档漂移（反向）：把真实列从 describeTable 结果里藏掉，让幻觉列成为唯一"事实"。 */
  hideColumns?: { table: string; column: string }[];
};

/**
 * 用 jsonSchema 而不是 zod：与项目 #1 的写法保持一致，也少一层依赖转换。
 *
 * `opts.sessionId`：save_query 提案归属（无登录项目的最小隔离）。
 * `opts.faults`：故障注入，评测专用。
 */
function makeTools(
  opts: { sessionId?: string; faults?: Faults; evalFlags?: { disableL2?: boolean } } = {},
) {
  /** 每次问答独立的状态 —— 见 createDataAgent 的注释，绝不复用。 */
  const state = {
    sqlAttempts: 0,
    lastResult: null as QueryResult | null,
  };
  const guard = createLoopGuard();

  /**
   * L3 无进展检测的包装：连续 N 次工具输出指纹相同 → 追加停止指令。
   * 放在所有工具外层而不是 runSql 里，因为"每步都查同一张表"也是绕圈。
   */
  function withLoopGuard<A>(name: string, fn: (input: A) => Promise<string | object>) {
    return async (input: A): Promise<string | object> => {
      const out = await fn(input);
      const warning = guard.track(name, typeof out === 'string' ? out : JSON.stringify(out));
      if (!warning) return out;
      return typeof out === 'string'
        ? out + L3_NOTICE
        : { ...out, loopWarning: L3_NOTICE };
    };
  }

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
    execute: withLoopGuard('listTables', async () => {
      // 行数现查：写死在文档里必然过时，而过时的数字不会报错、只会答错
      const counts = await getTableRowCounts(TABLE_DOCS.map((d) => d.table));
      return TABLE_DOCS.map((d) => {
        const n = counts.get(d.table);
        const size = n === undefined ? '' : `（${n} 行）`;
        return `${d.table}${size} — ${d.summary}`;
      }).join('\n');
    }),
  });

  const searchSchema = tool({
    description:
      '按业务关键词检索相关表（如「复购」「退货」「订阅」「退款」）。' +
      '问题涉及哪个业务域拿不准时用它，比 listTables 精准、比逐张 describeTable 便宜。' +
      '返回每张表命中的关键词，方便你判断相关性。',
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: '业务关键词，如「客户复购」或「退货原因」' },
      },
      required: ['query'],
    }),
    execute: withLoopGuard('searchSchema', async ({ query }: { query: string }) => {
      const ranked = rankTables(query, TABLE_DOCS, 5);
      if (!ranked.length) {
        return `没有命中任何表。建议改调 listTables 浏览全部 21 张表后再决定。`;
      }
      const lines = ranked.map(
        (r) => `• ${r.table} — 命中：${r.matched.join('、')}`,
      );
      return [
        '与你的关键词最相关的表（按匹配度排序）：',
        '',
        ...lines,
        '',
        '下一步：用 describeTable 看其中相关表的具体列名。',
      ].join('\n');
    }),
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
    execute: withLoopGuard('describeTable', async ({ table }: { table: string }) => {
      const doc = TABLE_DOC_MAP.get(table);
      let cols = await describeTableColumns(table, TABLE_DOC_MAP.keys());

      // 测试注入（仅评测路径）：模拟「文档漂移」——多出幻觉列 / 真实列被藏
      if (opts.faults?.driftColumns?.length) {
        const inject = opts.faults.driftColumns.filter((f) => f.table === table);
        for (const f of inject) {
          cols = [...cols, { column: f.column, type: 'timestamp without time zone', nullable: true }];
        }
      }
      if (opts.faults?.hideColumns?.length) {
        const hide = new Set(
          opts.faults.hideColumns.filter((f) => f.table === table).map((f) => f.column),
        );
        if (hide.size) cols = cols.filter((c) => !hide.has(c.column));
      }

      const lines = [
        `${table} — ${doc?.summary ?? ''}`,
        '',
        '| 列名 | 类型 | 可空 |',
        '| --- | --- | --- |',
        ...cols.map((c) => `| ${c.column} | ${c.type} | ${c.nullable ? '是' : '否'} |`),
      ];
      if (doc?.pitfall) lines.push('', `⚠️ ${doc.pitfall}`);
      return lines.join('\n');
    }),
  });

  const runSql = tool({
    description:
      '执行一条只读 SQL 查询并返回结果。只支持单条 SELECT 语句（CTE 可用），' +
      '最多返回 1000 行，超时 10 秒。报错信息会原样返回，你可以据此修正 SQL 重试。' +
      '成功的结果会被记住，可直接交给 make_chart 画图。',
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
    execute: withLoopGuard('runSql', async ({ sql }: { sql: string }) => {
      state.sqlAttempts += 1;
      if (state.sqlAttempts > MAX_ATTEMPTS_PER_TURN) {
        return (
          `本轮已经失败 ${MAX_ATTEMPTS_PER_TURN} 次，停止尝试。` +
          '请基于已有信息作答，并如实说明哪部分没能查到。'
        );
      }

      // ---- L1 完全重复：同一条 SQL（归一化后）第二次出现，直接不执行。
      // 数据是静态的，重跑同一条查询不可能有新结果；这一步几乎零成本，
      // 却能掐断最蠢也最常见的一种循环。
      if (guard.seenSql(sql)) {
        return l1Notice(state.lastResult !== null);
      }
      guard.markSqlSeen(sql);

      try {
        const result = await runReadOnlyQuery(sql);
        state.lastResult = result;
        guard.clearErrors(); // 换了新问题，旧错误的计数清零
        return formatForModel(result);
      } catch (e) {
        if (e instanceof SqlRejected) {
          return `这条 SQL 没被执行：${e.message}。请修改后重试。`;
        }
        if (e instanceof SqlExecutionError) {
          // ---- L2 同错重复：第 3 次撞同一个错误，说明它猜错了维度。
          // 给的不是"别再试了"，是"换诊断方向"——这是自修从碰运气变成有策略的关键。
          // evalFlags.disableL2 仅评测用：对比开/关 L2 的修复率（C13）。
          const times = guard.recordError(e.code, e.message);

          const parts = [`SQL 执行失败：${e.message}`];
          if (e.code) parts.push(`错误码：${e.code}`);
          if (e.hint) parts.push(`提示：${e.hint}`);
          if (e.position) parts.push(`出错位置（第 ${e.position} 个字符附近）`);
          if (times >= L2_SAME_ERROR_AT && !opts.evalFlags?.disableL2) {
            parts.push('', l2Notice(times));
          }
          return parts.join('\n');
        }
        throw e;
      }
    }),
  });

  /**
   * 精确算术。存在的理由见 calc.ts 顶部（D07：六行明细全对，合计加错 15.7 万）。
   *
   * `fromLastQuery` 是设计里更要紧的一半：如果只让模型把数字填进 values，它得先从
   * 表格里抄 6 个数过来，抄错一个照样错。让它直接指定列名，抄写这一步也一并消掉。
   * 而且取的是**完整结果**（不是给模型看的前 50 行）—— 这一点必须在返回里说明，
   * 否则模型会发现"我看到的 50 行加起来不等于它给的结果"。
   */
  const calc = tool({
    description: CALC_DESCRIPTION,
    inputSchema: jsonSchema<{
      op: CalcOp;
      values?: (number | string)[];
      fromLastQuery?: { column: string };
      expected?: number | string;
      decimals?: number;
      unit?: string;
    }>({
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['sum', 'avg', 'diff', 'product', 'ratio', 'pct_change', 'verify_sum'],
          description: '运算类型',
        },
        values: {
          type: 'array',
          items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          description: '参与运算的数（纯数字，不要带单位）；verify_sum 时是分项',
        },
        fromLastQuery: {
          type: 'object',
          properties: { column: { type: 'string', description: '结果表里的列名' } },
          required: ['column'],
          description:
            '从最近一次 runSql 的**完整结果**里取这一列作为 values（优先于 values）。' +
            '要算一整列的和/平均时用它，比手抄数字可靠。',
        },
        expected: { oneOf: [{ type: 'number' }, { type: 'string' }], description: '仅 verify_sum：你给出的合计' },
        decimals: { type: 'number', description: '保留几位小数，默认 2' },
        unit: { type: 'string', description: '仅用于展示，如「万元」「%」「人」' },
      },
      required: ['op'],
    }),
    execute: withLoopGuard(
      'calc',
      async (p: {
        op: CalcOp;
        values?: (number | string)[];
        fromLastQuery?: { column: string };
        expected?: number | string;
        decimals?: number;
        unit?: string;
      }) => {
        let values: (number | string)[] = p.values ?? [];
        let sourceNote = '';

        if (p.fromLastQuery?.column) {
          const last = state.lastResult;
          if (!last || !last.rows.length) {
            return '还没有可用的查询结果。先 runSql 查出数据，或者直接把数字放进 values。';
          }
          const col = p.fromLastQuery.column;
          if (!last.columns.includes(col)) {
            return `最近一次结果里没有列「${col}」。可用列：${last.columns.join('、')}`;
          }
          const picked = last.rows
            .map((row) => row[col])
            .filter((v) => v !== null && v !== undefined)
            .map((v) => String(v));
          if (!picked.length) return `列「${col}」的值全是 NULL，没有可计算的数。`;
          values = picked;
          sourceNote = `（取自最近一次查询的 ${picked.length} 行${
            last.rows.length > 50 ? '，含没展示给模型的行' : ''
          }）`;
        }

        if (!values.length) {
          return '没有可计算的数：请给 values，或用 fromLastQuery 指定列名。';
        }

        const r = calculate({
          op: p.op,
          values,
          expected: p.expected,
          decimals: p.decimals,
          unit: p.unit,
        });
        return r.ok ? `${r.display}${sourceNote}\n${r.detail}` : `计算失败：${r.error}`;
      },
    ),
  });

  const makeChart = tool({
    description:
      '把**最近一次 runSql 的结果**画成图表。数据由系统记住，你只需要指定：' +
      'type（bar/line/pie）、xKey、yKey（一列或多列）、title。' +
      '参数错误会返回具体原因和可用列名，修正后重试即可。',
    inputSchema: jsonSchema<{ type: string; title?: string; xKey: string; yKey: string | string[] }>({
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'line', 'pie'], description: '图表类型' },
        title: { type: 'string', description: '图表标题，可省略' },
        xKey: { type: 'string', description: 'X 轴列名' },
        yKey: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '度量列（画多少），一列或多列',
        },
      },
      required: ['type', 'xKey', 'yKey'],
    }),
    execute: withLoopGuard(
      'makeChart',
      async (p: {
        type: string;
        title?: string;
        xKey: string;
        yKey: string | string[];
      }): Promise<ChartSpec | string> => {
        try {
          return buildChartSpec(p, state.lastResult);
        } catch (e) {
          return chartErrorForModel(e);
        }
      },
    ),
  });

  const saveQuery = tool({
    description:
      '把一条有复用价值的 SQL 保存下来。**只在用户明确表达"保存"时使用**。' +
      '调用后生成一个待确认提案（10 分钟有效），用户在前端点确认后才真正保存——' +
      '你只需要告诉用户「已生成待确认的保存请求，请在卡片上确认」。',
    inputSchema: jsonSchema<{ title: string; sql: string; question?: string }>({
      type: 'object',
      properties: {
        title: { type: 'string', description: '查询标题，如「月度 GMV 趋势」' },
        sql: { type: 'string', description: '要保存的 SELECT 语句' },
        question: { type: 'string', description: '用户当时问的问题，可省略' },
      },
      required: ['title', 'sql'],
    }),
    execute: withLoopGuard(
      'saveQuery',
      async (p: { title: string; sql: string; question?: string }) => {
        if (!opts.sessionId) {
          return '保存功能需要会话上下文（cookie 丢失）。请刷新页面后重试。';
        }
        try {
          const proposal = await createProposal({ sessionId: opts.sessionId, ...p });
          return {
            status: 'pending_confirmation' as const,
            proposalId: proposal.proposalId,
            title: proposal.title,
            sql: proposal.sql,
            expiresInMin: proposal.expiresInMin,
          };
        } catch (e) {
          if (e instanceof SaveQueryRejected) {
            return `没能生成保存提案：${e.message}`;
          }
          return `保存提案生成失败，请稍后重试。`;
        }
      },
    ),
  });

  return { listTables, searchSchema, describeTable, runSql, calc, makeChart, saveQuery };
}

// ---------------------------------------------------------------- agent

/**
 * 每次请求新建一个 agent 实例。
 *
 * 不挂全局单例的原因：`makeTools()` 里的 state（尝试计数、上次查询结果、
 * 循环检测指纹）是**每轮对话独立**的，复用实例会让上一轮的状态算到下一轮头上
 * —— 这种 bug 极难复现。provider 是单例（贵），agent 是轻量的（几个对象的组合）。
 *
 * `opts.faults` / `opts.evalFlags` 只在评测里传，产品路径必须是 `createDataAgent({ sessionId })`。
 */
export function createDataAgent(
  opts: {
    sessionId?: string;
    faults?: Faults;
    evalFlags?: { disableL2?: boolean };
    thinking?: 'disabled' | 'enabled';
  } = {},
) {
  return new ToolLoopAgent({
    model: getChatModel(opts.thinking ?? 'disabled'),
    // ToolLoopAgent 里这个字段叫 instructions（不是 streamText 的 system）——
    // 语义相同，只是 Agent 抽象把"给模型的行为说明"独立命名了。
    instructions: PROMPT.system,
    tools: makeTools(opts),
    /**
     * 每一步前把"还剩几步"写进 instructions，并在最后一格关掉工具（step-budget.ts）。
     *
     * 为什么不用「工具返回里附加剩余步数」：那只有调了工具才看得到，而模型决定
     * "要不要再查一次"恰恰发生在调工具之前。prepareStep 是唯一能在模型开口前
     * 说话的位置。
     */
    prepareStep: ({ stepNumber }) => {
      const plan = planStep(stepNumber, MAX_STEPS);
      const instructions = `${PROMPT.system}\n\n${plan.notice}`;
      // 最后一格：工具物理关闭，模型只能写字。光靠"请回答"是软约束，模型可能
      // 再调一次工具把预算撞死；toolChoice:'none' 是硬约束。
      if (plan.mustAnswer) {
        // 留痕：这条日志出现，说明这一轮是把预算烧完才收口的（用于事后统计空答案风险面）
        console.log('[step-budget] 最后一格：关闭工具，强制作答');
        return { instructions, toolChoice: 'none' };
      }
      return { instructions };
    },
    // 步数上限 = 账单上限。没有上限的 agent 循环 = 没有上限的成本。
    stopWhen: ({ steps }) => steps.length >= MAX_STEPS,
  });
}

export type { QueryResult };
