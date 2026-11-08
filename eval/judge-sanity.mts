/**
 * 判据的变异检验：把历史答案里的数字全改错 50%，看判据还能不能判出错。
 *
 * 为什么需要它：准确率跑到 1.00 的时候，最该问的不是「模型真这么强？」而是
 * 「**判据是不是什么都判对**」。一个恒真的判据也能给 1.00。
 * 这里用最粗的变异——所有数字 +7%（远超任何一条的容差，最大的是 D06 的 10%）——如果还有条目判对，
 * 说明它在用答案里别的数字凑命中，那 1.00 就是假的。
 *
 * 纯离线，不花钱、不调模型。用法：
 *   node --experimental-transform-types eval/judge-sanity.mts [结果文件]
 */

import fs from 'node:fs';
import { judgeAnswer } from '../src/lib/qa-judge.ts';
import { toJudgeInput, type EvalCase } from './judge-input.ts';

type Verdict = { id: string; hit: boolean; answer: string };

const path = process.argv[2] ?? 'eval/results/qa.json';
const set = JSON.parse(fs.readFileSync('eval/qa-set.json', 'utf8')) as { cases: EvalCase[] };
const res = JSON.parse(fs.readFileSync(path, 'utf8')) as { verdicts: Verdict[] };
const byId = new Map(set.cases.map((c) => [c.id, c]));

const RATE = 1.5;

/** 把文本里每个数字乘 1.07，保留原格式（千分位 / 小数位 / 万亿后缀）。 */
function mutateNumbers(text: string): string {
  return text.replace(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(亿|万|千|[kKmM])?/g, (all, int, dec, suf) => {
    const base = Number(String(int).replace(/,/g, '') + (dec ? `.${dec}` : ''));
    if (!Number.isFinite(base)) return all;
    const next = base * RATE;
    // 整数不能四舍五入回原值：3 × 1.07 = 3.21 → round 回 3 就等于没变异。
    // 所以整数也保留两位（"3 天" 变 "3.21 天"）——合成数据难看无所谓，值必须真的移动。
    let body = dec ? next.toFixed(dec.length) : next.toFixed(2);
    if (String(int).includes(',')) {
      const [i, f] = body.split('.');
      body = Number(i).toLocaleString('en-US') + (f ? `.${f}` : '');
    }
    return body + (suf ?? '');
  });
}

let checked = 0;
const survived: { id: string; detail: string; answer: string }[] = [];

for (const v of res.verdicts) {
  const c = byId.get(v.id);
  if (!c) continue;
  // 拒答题判的是「有没有说不」，开放题判关键词——这两类改数字不影响，跳过
  if (c.mode === 'refuse' || c.mode === 'qualitative') continue;
  if (!v.hit) continue; // 原本就没命中的不算样本

  checked++;
  const out = judgeAnswer(toJudgeInput(c), mutateNumbers(v.answer));
  if (out.hit) survived.push({ id: v.id, detail: out.detail, answer: mutateNumbers(v.answer) });
}

console.log(`变异检验：${checked} 条原本命中的答案，数字全部 +${((RATE - 1) * 100).toFixed(0)}% 后重判`);
console.log(`  仍被判对（说明判据在用别的数字凑）：${survived.length}/${checked}`);
for (const s of survived) {
  console.log(`  ✗ ${s.id}  ${s.detail}`);
  console.log(`     ${s.answer.slice(0, 110).replace(/\n/g, ' ')}`);
}
if (survived.length === 0) console.log('  ✓ 全部判错 —— 判据不是恒真的');
