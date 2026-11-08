/**
 * W3 C17：40 条标注评测集，五项指标。
 *
 * 运行：`npx vitest run eval/qa.eval.ts`（约 5-10 分钟，40 次真实 LLM 调用）
 *
 * 判定原则（docs/ACCEPTANCE-W3.md 3.2）：
 *   自动判据**宁可严**。未命中的一律进 `unmatched`，由人工复核区分「真错」和「判据误判」。
 *   W2 已经有两次因为判据太宽/太窄把结论搞反（C13 修复率 0.08、C2 断言算错），
 *   所以这里不追求「一次跑出漂亮数字」，追求「数字敢拿出去」。
 */

import { describe, it } from 'vitest';
import fs from 'fs';
import { runTurn, type TurnResult } from './harness';
import { judgeAnswer } from '../src/lib/qa-judge';
import { toJudgeInput, type EvalCase } from './judge-input';

const SET = JSON.parse(fs.readFileSync('eval/qa-set.json', 'utf8')) as { meta: unknown; cases: EvalCase[] };

// ------------------------------------------------------------------ 判定

type Verdict = {
  id: string;
  cls: string;
  mode: string;
  question: string;
  /** 数字是否命中（refuse 类是「是否拒答」）。 */
  hit: boolean;
  /** caveat 类：是否提到口径限制。非 caveat 类为 null。 */
  caveatOk: boolean | null;
  expected: string;
  detail: string;
  answer: string;
  steps: number;
  /** 是否走了兜底收口（步数用尽后补的那一次调用）。 */
  wrappedUp: boolean;
  tokens: number;
  firstTokenMs: number | null;
  elapsedMs: number;
};

function judge(c: EvalCase, r: TurnResult): Verdict {
  const v = judgeAnswer(toJudgeInput(c), r.answer);
  return {
    id: c.id,
    cls: c.cls,
    mode: c.mode,
    question: c.question,
    hit: v.hit,
    caveatOk: v.caveatOk,
    expected: v.expected,
    detail: v.detail,
    answer: r.answer,
    steps: r.tools.length,
    wrappedUp: r.wrappedUp,
    tokens: r.usage.totalTokens,
    firstTokenMs: r.firstTokenMs,
    elapsedMs: r.elapsedMs,
  };
}

// ------------------------------------------------------------------ 跑

describe('W3 C17 · 40 条标注评测集', () => {
  it('全量跑 + 五项指标', { timeout: 30 * 60 * 1000 }, async () => {
    const verdicts: Verdict[] = [];

    for (const c of SET.cases) {
      const started = Date.now();
      const r = await runTurn(c.question);
      const v = judge(c, r);
      verdicts.push(v);
      const flag = v.hit ? '✓' : '✗';
      const cflag = v.caveatOk === null ? '' : v.caveatOk ? ' [口径✓]' : ' [口径✗]';
      console.log(
        `${flag} ${c.id} ${c.cls} ${String(v.steps).padStart(2)}步 ${String(v.tokens).padStart(6)}tok ` +
        `${String(Date.now() - started).padStart(6)}ms${cflag}${v.wrappedUp ? ' [兜底]' : ''}`,
      );
      if (!v.hit) console.log(`     期望 ${v.expected}\n     实答 ${v.answer.slice(0, 160).replace(/\n/g, ' ')}`);
    }

    // ---- 五项指标
    const n = verdicts.length;
    const hit = verdicts.filter((v) => v.hit).length;
    const caveatCases = verdicts.filter((v) => v.caveatOk !== null);
    const caveatOk = caveatCases.filter((v) => v.caveatOk).length;
    const steps = verdicts.reduce((s, v) => s + v.steps, 0) / n;
    const tokens = verdicts.reduce((s, v) => s + v.tokens, 0) / n;
    const firsts = verdicts.map((v) => v.firstTokenMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const p95 = firsts.length ? firsts[Math.min(firsts.length - 1, Math.ceil(firsts.length * 0.95) - 1)] : null;

    const byClass: Record<string, { hit: number; n: number }> = {};
    for (const v of verdicts) {
      byClass[v.cls] ??= { hit: 0, n: 0 };
      byClass[v.cls].n += 1;
      if (v.hit) byClass[v.cls].hit += 1;
    }

    // 无结论答案是独立指标：混在准确率里既会低估（答对的被算错）也会掩盖（"0.95 已经很好了"）。
    // 判定用长度而不是「trim 后为空」：第六轮 D06 的答案是 16 个字的
    // 「我先看一下数据库里有哪些相关表。」—— trim 不为空，但同样没有结论。
    // 三轮实测正常答案最短 131 字（第七轮 A08），30 这条线有空档，不会误伤。
    const NO_CONCLUSION_CHARS = 30;
    const empty = verdicts.filter((v) => v.answer.trim().length === 0);
    const noConclusion = verdicts.filter((v) => v.answer.trim().length < NO_CONCLUSION_CHARS);
    const wrapped = verdicts.filter((v) => v.wrappedUp);

    const metrics = {
      accuracy: hit / n,
      emptyAnswers: empty.length,
      noConclusion: noConclusion.length,
      wrappedUp: wrapped.length,
      caveatHonesty: caveatCases.length ? caveatOk / caveatCases.length : 0,
      avgSteps: steps,
      avgTokens: tokens,
      p95FirstTokenMs: p95,
    };

    console.log('\n' + '─'.repeat(64));
    console.log(`准确率        ${hit}/${n} = ${metrics.accuracy.toFixed(2)}  (门槛 0.70)`);
    console.log(`无结论答案    ${noConclusion.length} 条（真空 ${empty.length} 条）  (门槛 0)`);
    console.log(`兜底收口      ${wrapped.length} 条`);
    console.log(`口径诚实率    ${caveatOk}/${caveatCases.length} = ${metrics.caveatHonesty.toFixed(2)}  (门槛 0.60)`);
    console.log(`平均步数      ${metrics.avgSteps.toFixed(1)}  (门槛 ≤5)`);
    console.log(`平均 token    ${Math.round(metrics.avgTokens)}  (门槛 ≤12000)`);
    console.log(`P95 首字      ${p95} ms  (门槛 ≤5000)`);
    console.log('分类命中      ' + Object.entries(byClass).map(([k, v]) => `${k} ${v.hit}/${v.n}`).join(' · '));

    const unmatched = verdicts.filter((v) => !v.hit).map((v) => ({
      id: v.id, cls: v.cls, question: v.question, expected: v.expected, answer: v.answer,
    }));
    console.log(`\n未命中 ${unmatched.length} 条 —— 需人工复核（区分真错 vs 判据误判）:`);
    for (const u of unmatched) console.log(`  ${u.id} [${u.cls}] ${u.question}  期望 ${u.expected}`);

    fs.mkdirSync('eval/results', { recursive: true });
    fs.writeFileSync(
      'eval/results/qa.json',
      JSON.stringify({ ranAt: new Date().toISOString(), metrics, byClass, verdicts, unmatched }, null, 2),
      'utf8',
    );
    console.log('\n结果已写入 eval/results/qa.json');
  });
});
