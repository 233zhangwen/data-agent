/**
 * 离线重判：拿历史跑出来的答案，用**当前**判据重新判一遍。
 *
 * 为什么需要它（W3 第五轮之后加的）：
 *   改判据时如果每次都重跑 40 次 LLM，你分不清「分数变了」是因为判据变了
 *   还是因为模型这次答得不一样——两个变量搅在一起，等于没做实验。
 *   重判把模型输出固定住，只动判据，这才叫对照。
 *
 * 用法：
 *   node --experimental-transform-types eval/rejudge.mts                     # 默认读 eval/results/qa.json
 *   node --experimental-transform-types eval/rejudge.mts eval/results/qa-r5.json
 *
 * 注意：它只能重判**存了 answer 的**结果文件。qa.json 里每条 verdict 都带完整答案，
 * 就是为了这件事——数字可以以后重算，答案不留就永远算不回来了。
 */

import fs from 'node:fs';
import { judgeAnswer } from '../src/lib/qa-judge.ts';
import { toJudgeInput, type EvalCase } from './judge-input.ts';

type Verdict = {
  id: string;
  hit: boolean;
  caveatOk: boolean | null;
  detail: string;
  answer: string;
};

const path = process.argv[2] ?? 'eval/results/qa.json';
const set = JSON.parse(fs.readFileSync('eval/qa-set.json', 'utf8')) as { cases: EvalCase[] };
const res = JSON.parse(fs.readFileSync(path, 'utf8')) as { verdicts: Verdict[] };

const byId = new Map(set.cases.map((c) => [c.id, c]));
const rows: { id: string; before: boolean; after: boolean; detail: string; answer: string }[] = [];

for (const v of res.verdicts) {
  const c = byId.get(v.id);
  if (!c) {
    console.error(`✗ ${v.id} 在 qa-set.json 里找不到（题被删了？）`);
    process.exitCode = 1;
    continue;
  }
  const out = judgeAnswer(toJudgeInput(c), v.answer);
  rows.push({ id: v.id, before: v.hit, after: out.hit, detail: out.detail, answer: v.answer });
}

const n = rows.length;
const b = rows.filter((r) => r.before).length;
const a = rows.filter((r) => r.after).length;

console.log(`重判 ${path}（${n} 条）`);
console.log(`  命中：改判前 ${b}/${n} = ${(b / n).toFixed(3)}  →  改判后 ${a}/${n} = ${(a / n).toFixed(3)}`);
if (b !== a) console.log(`  ⚠ 判据改动让 ${Math.abs(a - b)} 条结论翻转——这是判据的问题，不是模型的问题`);

const flipped = rows.filter((r) => r.before !== r.after);
if (flipped.length) {
  console.log('\n翻转明细：');
  for (const r of flipped) {
    console.log(`  ${r.id} ${r.before ? '✓→✗' : '✗→✓'}  ${r.detail}`);
    console.log(`     ${r.answer.slice(0, 110).replace(/\n/g, ' ')}`);
  }
}

// 口径诚实率（interpretations / caveat / qualitative 才有意义）
let judged = 0;
let honest = 0;
for (const v of res.verdicts) {
  const c = byId.get(v.id);
  if (!c) continue;
  const out = judgeAnswer(toJudgeInput(c), v.answer);
  if (out.caveatOk === null) continue;
  judged++;
  if (out.caveatOk) honest++;
}
if (judged) {
  console.log(`\n口径诚实率：${honest}/${judged} = ${(honest / judged).toFixed(2)}`);
}
