/**
 * C13 + C14：SQL 错误自修的定量评测（真实 LLM 调用，约 6–8 分钟）。
 *
 * ⚠️ 评测设计被推倒过一次，过程值得记住：
 *   第一版把「用户贴来坏 SQL 请 Agent 修好再执行」当 C13 的场景，结果修复率 0.08——
 *   不是模型差，是**模型太聪明**：它静态读出 4 个 bug、改对了才执行，全程 0 报错，
 *   我的判据「必须撞过一次 SQL 错误」把它判成了失败。行为分层之后重新设计：
 *
 *   A 路径（静态审查）：「这条 SQL 有什么问题？修好并执行」
 *        → 量「执行前发现问题的比例」（高级行为，省掉撞错的那次往返）
 *   B 路径（报错驱动）：「帮我执行这条 SQL」（不提示有问题，模型大概率原样跑、撞错）
 *        → 量 C13 原意：「撞错之后能否自己修对」，L2 开/关对照
 *
 *   C14（死循环有界）：注入真正的不可解失败——describeTable 只显示幻觉列
 *   created_at（真实列 ordered_at 被藏掉）→ 模型怎么改都会错，看它在 MAX_STEPS 前还是后停。
 *
 * 运行：npx vitest run eval/repair.eval.ts（结果写 eval/results/repair.json）
 */

import { afterAll, describe, it } from 'vitest';

import { runTurn, type TurnResult } from './harness';
import fs from 'fs';

type Case = { id: string; cls: string; broken: string };

const CASES: Case[] = [
  // ---- 错误列名 ×4
  { id: 'col-1', cls: '错列名', broken: 'SELECT order_num, total_amount FROM orders LIMIT 5' },
  { id: 'col-2', cls: '错列名', broken: 'SELECT name, region FROM customers LIMIT 5' },
  { id: 'col-3', cls: '错列名', broken: 'SELECT product_name, base_price FROM products LIMIT 5' },
  { id: 'col-4', cls: '错列名', broken: 'SELECT r.order_id, r.quantity, r.reason FROM returns r LIMIT 5' },
  // ---- 类型不匹配 ×2
  { id: 'type-1', cls: '类型不匹配', broken: 'SELECT * FROM orders WHERE order_no = 1001' },
  { id: 'type-2', cls: '类型不匹配', broken: 'SELECT count(*) FROM orders WHERE ordered_at = 20261001' },
  // ---- 漏 GROUP BY ×2
  { id: 'grp-1', cls: '漏GROUP BY', broken: 'SELECT status, count(*) FROM orders' },
  {
    id: 'grp-2',
    cls: '漏GROUP BY',
    broken: 'SELECT c.type, SUM(o.total_amount) FROM customers c JOIN orders o ON o.customer_id = c.id',
  },
  // ---- 缺 JOIN 条件 ×2
  {
    id: 'join-1',
    cls: '缺JOIN',
    broken: 'SELECT c.name, count(o.id) AS order_count FROM customers c JOIN orders o GROUP BY c.name',
  },
  {
    id: 'join-2',
    cls: '缺JOIN',
    broken: 'SELECT p.name, SUM(oi.quantity) AS sold FROM products p JOIN order_items oi JOIN orders o ON oi.order_id = o.id GROUP BY p.name ORDER BY sold DESC LIMIT 5',
  },
  // ---- 除零 ×1
  {
    id: 'div-1',
    cls: '除零',
    broken: "SELECT 1 / (SELECT count(*) FROM orders WHERE status = 'no_such_status') AS ratio",
  },
  // ---- 日期比较类型错 ×1
  {
    id: 'date-1',
    cls: '日期格式',
    broken: "SELECT count(*) FROM orders WHERE ordered_at >= '2026年10月01日'",
  },
];

const PROMPT_A = (sql: string) =>
  `帮我看下面这条 SQL 有什么问题、修好它，然后执行并告诉我结果：\n\n\`\`\`sql\n${sql}\n\`\`\``;
const PROMPT_B = (sql: string) => `帮我执行这条 SQL，把结果告诉我：\n\n\`\`\`sql\n${sql}\n\`\`\``;

type CaseResult = {
  id: string;
  cls: string;
  /** B 路径：撞错后修好（C13 原意）。 */
  repairedAfterError: boolean;
  /** A/B 共用：最终以成功的查询收尾且给了非空回答。 */
  delivered: boolean;
  /** B 路径：0 报错直接跑通 = 模型静态修复后才执行（绕过了撞错）。 */
  staticFixed: boolean;
  sqlErrors: number;
  steps: number;
  totalTokens: number;
  elapsedMs: number;
  answerHead: string;
};

function toCaseResult(r: TurnResult, c: Case): CaseResult {
  const executed = r.tools.filter((t) => t.name === 'runSql' && t.output !== '');
  return {
    id: c.id,
    cls: c.cls,
    repairedAfterError: r.sqlErrors >= 1 && r.lastSqlOk && r.answer.length > 0,
    delivered: r.lastSqlOk && r.answer.length > 0,
    staticFixed: r.sqlErrors === 0 && executed.length > 0 && r.lastSqlOk,
    sqlErrors: r.sqlErrors,
    steps: r.tools.length,
    totalTokens: r.usage.totalTokens,
    elapsedMs: r.elapsedMs,
    answerHead: r.answer.slice(0, 80),
  };
}

function summarize(label: string, rows: CaseResult[], metric: keyof CaseResult): void {
  const n = rows.length;
  const good = rows.filter((r) => r[metric] === true).length;
  const avgRetries = rows.reduce((s, r) => s + r.sqlErrors, 0) / n;
  const avgSteps = rows.reduce((s, r) => s + r.steps, 0) / n;
  console.log(`\n===== ${label} =====`);
  console.log(
    `${String(metric)} ${good}/${n} = ${(good / n).toFixed(2)} | 平均重试 ${avgRetries.toFixed(2)} | 平均步数 ${avgSteps.toFixed(1)}`,
  );
  const fails = rows.filter((r) => r[metric] !== true);
  if (fails.length) {
    console.log('未达成案例：');
    for (const f of fails) {
      console.log(`  ${f.id}（${f.cls}）retry=${f.sqlErrors} steps=${f.steps}：${f.answerHead}`);
    }
  }
}

const all: Record<string, unknown> = {};

afterAll(() => {
  fs.mkdirSync('eval/results', { recursive: true });
  fs.writeFileSync('eval/results/repair.json', JSON.stringify(all, null, 2));
  console.log('\n已写入 eval/results/repair.json');
});

describe('C13 · SQL 错误自修（真实 LLM）', () => {
  it('A 路径 · 静态审查：给机会让它先看再跑', async () => {
    const rows: CaseResult[] = [];
    for (const c of CASES) {
      const r = await runTurn(PROMPT_A(c.broken));
      rows.push(toCaseResult(r, c));
      console.log(`  ${c.id} ${r.tools.length} 步 retry=${r.sqlErrors} ${rows.at(-1)!.delivered ? '✓' : '✗'}`);
    }
    all['a_static'] = rows;
    summarize('A 静态审查（成功 = 交付了结果）', rows, 'delivered');
    const staticRate = rows.filter((r) => r.sqlErrors === 0).length / rows.length;
    console.log(`其中 0 报错（纯静态修复）占 ${(staticRate * 100).toFixed(0)}%`);
  }, 900_000);

  it('B 路径 · L2 开：只说执行，逼它撞错', async () => {
    const rows: CaseResult[] = [];
    for (const c of CASES) {
      const r = await runTurn(PROMPT_B(c.broken));
      rows.push(toCaseResult(r, c));
      console.log(`  ${c.id} ${r.tools.length} 步 retry=${r.sqlErrors} ${rows.at(-1)!.repairedAfterError ? '✓' : '✗'}`);
    }
    all['b_l2_on'] = rows;
    summarize('B 报错驱动 · L2 开（成功 = 撞错后修好交付）', rows, 'repairedAfterError');
    const staticRate = rows.filter((r) => r.staticFixed).length / rows.length;
    console.log(`其中静态修复绕过撞错的占 ${(staticRate * 100).toFixed(0)}%`);
  }, 900_000);

  it('B 路径 · L2 关（对照组）', async () => {
    const rows: CaseResult[] = [];
    for (const c of CASES) {
      const r = await runTurn(PROMPT_B(c.broken), { evalFlags: { disableL2: true } });
      rows.push(toCaseResult(r, c));
      console.log(`  ${c.id} ${r.tools.length} 步 retry=${r.sqlErrors} ${rows.at(-1)!.repairedAfterError ? '✓' : '✗'}`);
    }
    all['b_l2_off'] = rows;
    summarize('B 报错驱动 · L2 关', rows, 'repairedAfterError');
  }, 900_000);

  it('C14 · 不可解失败在 MAX_STEPS 前停下', async () => {
    // 真不可解：幻觉列 created_at 注入 + 真实列 ordered_at 藏掉
    // → describeTable 只见 created_at → 模型按"文档"写 SQL 必然报错，且无路可修
    const r = await runTurn(
      '查最近 5 笔订单的下单时间和金额，按下单时间倒序。SQL 大致是：SELECT created_at, total_amount FROM orders ORDER BY created_at DESC LIMIT 5',
      {
        faults: {
          driftColumns: [{ table: 'orders', column: 'created_at' }],
          hideColumns: [{ table: 'orders', column: 'ordered_at' }],
        },
      },
    );
    const sqlFails = r.tools.filter(
      (t) => t.name === 'runSql' && typeof t.output === 'string' && t.output.includes('SQL 执行失败'),
    ).length;
    const l2Fired = r.tools.some(
      (t) => typeof t.output === 'string' && t.output.includes('同一个错误你已经撞上'),
    );
    const l3Fired = r.tools.some(
      (t) => typeof t.output === 'string' && t.output.includes('完全相同的结果'),
    );
    const honest = /无法|不能|查不到|没有|失败/.test(r.answer);
    console.log(
      `C14：${r.tools.length} 步（上限 10）/ SQL 报错 ${sqlFails} / L2 触发 ${l2Fired} / L3 触发 ${l3Fired} / 如实说明 ${honest}`,
    );
    console.log('回答开头：', r.answer.slice(0, 200));

    all['c14'] = {
      steps: r.tools.length,
      sqlErrors: sqlFails,
      l2Fired,
      l3Fired,
      honest,
      bounded: r.tools.length < 10 || l2Fired || l3Fired,
      usage: r.usage,
      answerHead: r.answer.slice(0, 200),
    };

    // 判据（spec C14）：比 MAX_STEPS 更早有界停止，或至少拿到过明确的诊断指令
    const bounded = r.tools.length < 10 || l2Fired || l3Fired;
    console.log(`有界停止：${bounded ? '✓' : '✗'}`);
  }, 300_000);
});
