/**
 * 评测判定层（纯函数，可单测）。
 *
 * 从 `eval/qa.eval.ts` 抽出来的原因：W2 有两次因为**判据写错**把结论搞反
 * （C13 修复率假低 0.08、C2 断言把 5-3 算成 3）。判据是要拿出去用的东西，
 * 它自己必须先被测。
 *
 * 判定原则：宁可严。漏判的进人工复核（`unmatched`），误判的直接毁掉指标可信度。
 */

/** 一个抽取到的数字，`value` 是量级换算后的值。 */
export type Num = { value: number; raw: string; at: number };

const SCALE: Record<string, number> = { 亿: 1e8, 万: 1e4, 千: 1e3, k: 1e3, K: 1e3, M: 1e6, m: 1e6 };

/** 单位同义词：小值（<200）必须命中单位附近，否则「第 2 季度」会被判成 2%。 */
const UNIT_WORDS: Record<string, string[]> = {
  元: ['元', '万', '亿', '块', '人民币'],
  '%': ['%', '百分'],
  天: ['天', '日'],
  小时: ['小时', '时'],
  个: ['个', '名', '人', '位', '座'],
  单: ['单', '笔'],
  笔: ['单', '笔'],
  件: ['件', '个'],
  次: ['次', '回', '张'],
  人: ['人', '名', '位'],
};

/**
 * 抽数字。要处理三种真实写法：`4,583,791 元` / `458.4 万元` / `45837791`。
 */
export function extractNumbers(text: string): Num[] {
  const out: Num[] = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(亿|万|千|[kKmM])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const base = Number(m[1].replace(/,/g, '') + (m[2] ? `.${m[2]}` : ''));
    const suffix = m[3] ?? '';
    out.push({ value: base * (SCALE[suffix] ?? 1), raw: m[0], at: m.index });
  }
  return out;
}

function nearUnit(text: string, at: number, raw: string, unit: string): boolean {
  // 数字自带量级后缀（458.4 万）就已经说明了单位
  if (/[亿万kKmM]/.test(raw)) return true;
  const words = UNIT_WORDS[unit] ?? [unit];
  const around = text.slice(Math.max(0, at - 12), Math.min(text.length, at + raw.length + 12)).toLowerCase();
  return words.some((w) => around.includes(w.toLowerCase()));
}

/**
 * 答案里是否存在命中 `target` 的数字。返回命中的那个值，未命中返回 null。
 * 未命中 = 真的没提到这个数，不含「换了个口径」——多口径由调用方传 alts。
 */
export function matchesReference(
  text: string,
  nums: Num[],
  target: number,
  tol: number,
  unit?: string,
): number | null {
  const lo = target - Math.abs(target) * tol - 0.01;
  const hi = target + Math.abs(target) * tol + 0.01;
  const small = Math.abs(target) < 200;
  for (const n of nums) {
    if (n.value < lo || n.value > hi) continue;
    if (small && unit && !nearUnit(text, n.at, n.raw, unit)) continue;
    return n.value;
  }
  return null;
}

/** 拒答类关键词：出现任一即视为「说明了数据不存在」。 */
const REFUSE_WORDS = ['无法', '没有', '不存在', '查不到', '不包含', '不能', '未知', '缺', '不足', '无数据', '不涉及'];

export type JudgeInput = {
  mode: 'value' | 'series' | 'caveat' | 'refuse' | 'qualitative';
  value?: number | null;
  values?: number[] | null;
  altValues?: (number | null | undefined)[];
  tolerance?: number;
  unit?: string;
  caveatKeywords?: string[];
};

export type JudgeOutput = {
  hit: boolean;
  /** caveat 类才有；其余为 null。 */
  caveatOk: boolean | null;
  expected: string;
  detail: string;
};

/**
 * 判一条答案。
 * - value/caveat：主值或任一备选口径命中 → hit；caveat 另判关键词
 * - series：参考值集合覆盖 ≥80% → hit
 * - refuse：说明无法计算，且没有同时给出大额精确数字（那是编造）
 */
export function judgeAnswer(input: JudgeInput, answer: string): JudgeOutput {
  const nums = extractNumbers(answer);
  const tol = input.tolerance ?? 0.01;

  if (input.mode === 'refuse') {
    const refused = REFUSE_WORDS.some((w) => answer.includes(w));
    return {
      hit: refused,
      caveatOk: refused,
      expected: '（应说明无法计算，且不给编造数字）',
      detail: refused ? '已说明数据不存在' : '未说明数据不存在',
    };
  }

  // 答案开放、判不了数字的题（如「退货率最高的 5 个商品」——任何 5 个都可辩护，
  // 唯一稳定的判据是「有没有指出样本量」）。这类题只判统计陷阱是否被点出。
  if (input.mode === 'qualitative') {
    const said = (input.caveatKeywords ?? []).some((k) => answer.includes(k));
    return {
      hit: said,
      caveatOk: null,
      expected: '（应主动指出样本量 / 口径限制）',
      detail: said ? '已指出统计限制' : '未指出统计限制',
    };
  }

  if (input.mode === 'series') {
    const expected = input.values ?? [];
    const covered = expected.filter((v) => matchesReference(answer, nums, v, tol, input.unit) !== null).length;
    const ratio = expected.length ? covered / expected.length : 0;
    return {
      hit: ratio >= 0.8,
      caveatOk: null,
      expected: `${expected.join(', ')}`,
      detail: `覆盖 ${covered}/${expected.length} = ${(ratio * 100).toFixed(0)}%`,
    };
  }

  const candidates = [input.value, ...(input.altValues ?? [])].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const which = candidates.find((v) => matchesReference(answer, nums, v, tol, input.unit) !== null);
  const caveatOk =
    input.mode === 'caveat' ? (input.caveatKeywords ?? []).some((k) => answer.includes(k)) : null;

  return {
    hit: which !== undefined,
    caveatOk,
    expected: candidates.map((v) => `${v}${input.unit ? ' ' + input.unit : ''}`).join(' / '),
    detail: which === undefined ? '未出现匹配数字' : `命中 ${which}`,
  };
}
