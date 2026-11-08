/**
 * 题 → 判据输入 的映射（唯一一处）。
 *
 * 抽出来的原因：`qa.eval.ts`（跑真实 LLM）和 `rejudge.mts`（拿历史答案离线重判）
 * 必须用**同一份**映射。判据漂移最先出现的地方从来不是算法，是这种"两边各写一遍"的适配层。
 */

import type { JudgeInput } from '../src/lib/qa-judge';

export type Interp = { label: string; keywords?: string[]; sql?: string[]; value?: number | null };
export type Alt = { sql: string[]; note: string; value?: number | null };

export type EvalCase = {
  id: string;
  cls: 'A' | 'B' | 'C' | 'D';
  mode: 'value' | 'series' | 'caveat' | 'refuse' | 'qualitative' | 'interpretations';
  question: string;
  sql?: string[];
  alts?: Alt[];
  interpretations?: Interp[];
  value?: number | null;
  values?: number[] | null;
  tolerance?: number;
  unit?: string;
  caveatKeywords?: string[];
  note?: string;
};

export function toJudgeInput(c: EvalCase): JudgeInput {
  return {
    mode: c.mode,
    value: c.value,
    values: c.values,
    altValues: (c.alts ?? []).map((a) => a.value),
    interpretations: c.interpretations?.map((i) => ({
      label: i.label,
      value: i.value,
      keywords: i.keywords,
    })),
    tolerance: c.tolerance,
    unit: c.unit,
    caveatKeywords: c.caveatKeywords,
  };
}
