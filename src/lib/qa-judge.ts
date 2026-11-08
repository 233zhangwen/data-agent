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
 * 答案里是否存在命中 `target` 的数字。返回命中的值与它在文中的位置，未命中返回 null。
 * 未命中 = 真的没提到这个数，不含「换了个口径」——多口径由调用方传 interpretations。
 *
 * `at` 是给「一条答案里出现多个口径的数字」用的：D03 的答案先给结论 1,120.4 万，
 * 后面的表格里又列了分项 458.4 万。只看「命中了哪个值」会命中分项，
 * 取位置最靠前的那个才等于取结论。
 */
export function matchesReference(
  text: string,
  nums: Num[],
  target: number,
  tol: number,
  unit?: string,
): { value: number; at: number } | null {
  const lo = target - Math.abs(target) * tol - 0.01;
  const hi = target + Math.abs(target) * tol + 0.01;
  const small = Math.abs(target) < 200;
  for (const n of nums) {
    if (n.value < lo || n.value > hi) continue;
    if (small && unit && !nearUnit(text, n.at, n.raw, unit)) continue;
    return { value: n.value, at: n.at };
  }
  return null;
}

/** 拒答类关键词：出现任一即视为「说明了数据不存在」。 */
const REFUSE_WORDS = ['无法', '没有', '不存在', '查不到', '不包含', '不能', '未知', '缺', '不足', '无数据', '不涉及'];

/**
 * 一个可接受的口径（D 类题的判据单元）。
 *
 * `keywords` 不是可有可无的装饰：它解决的是「数字对、但解释是另一套口径」这种
 * 最容易被漏掉的情况——答案写着 2950 万（原价 − 退款）却解释成"已按折扣分摊"，
 * 数字能对上某个口径，但那句话是错的。只比数字会判它对，比关键词才判得出问题。
 */
export type Interpretation = {
  /** 口径名，报告里直接展示「它选了哪个口径」。 */
  label: string;
  /** 该口径下的参考值；null 表示还没校准（判据会跳过，不静默当成 0）。 */
  value?: number | null;
  /** 这个口径必然出现在解释里的词，任一命中即认为它说明了口径。 */
  keywords?: string[];
};

export type JudgeInput = {
  mode: 'value' | 'all' | 'series' | 'caveat' | 'refuse' | 'qualitative' | 'interpretations';
  value?: number | null;
  values?: number[] | null;
  altValues?: (number | null | undefined)[];
  tolerance?: number;
  unit?: string;
  caveatKeywords?: string[];
  /** interpretations 模式专用：可接受口径清单（第一个是主口径）。 */
  interpretations?: Interpretation[];
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
 * - all：参考值**全部**命中 → hit（多问一题、每个数都要对）
 * - series：参考值集合覆盖 ≥80% → hit（月度序列容忍个别项缺失）
 * - refuse：说明无法计算（W3 起不再因附录数字判编造，那会误伤正确拒答）
 * - qualitative：只判统计陷阱有没有被点出
 * - interpretations：命中任一可接受口径 → hit；caveatOk 判「解释是否与命中的口径一致」
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

  // 「一题多问」类：题目要求给出好几个数（如新客订单数与老客订单数），
  // 只要有一个不对就是没答对。series 的 ≥80% 覆盖在这里不适用 —— 2 个值缺 1 个只剩 50%，
  // 5 个值缺 1 个却是 80%，恰好放行，这个阈值本来是为 12 个月的序列设的。
  if (input.mode === 'all') {
    const expected = input.values ?? [];
    if (expected.length === 0) throw new Error('all 模式至少需要一个参考值，否则恒真');
    const missed = expected.filter((v) => matchesReference(answer, nums, v, tol, input.unit) === null);
    return {
      hit: missed.length === 0,
      caveatOk: null,
      expected: expected.map((v) => `${v}${input.unit ? ' ' + input.unit : ''}`).join(' + '),
      detail: missed.length === 0 ? `全部命中（${expected.length} 项）` : `缺 ${missed.length} 项：${missed.join(', ')}`,
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

  // D 类口径题：没有唯一正确答案，判「落在某一套可接受口径上，且解释与该口径一致」。
  // 这是 W3 第四轮停手后补的做法（docs/ACCEPTANCE-W3.md 7.3）——上一版用单一数字判，
  // 同一道题四次跑给四个数、四个都对，全被判成失败。
  if (input.mode === 'interpretations') {
    const cands = (input.interpretations ?? []).filter(
      (i): i is Interpretation & { value: number } =>
        typeof i.value === 'number' && Number.isFinite(i.value),
    );
    if (cands.length === 0) {
      // 静默返回「未命中」会让校准漏掉的条目看起来像模型答错，必须炸出来
      throw new Error('interpretations 模式至少需要一个已校准 value 的口径');
    }

    const hits = cands
      .map((i) => ({ interp: i, m: matchesReference(answer, nums, i.value, tol, input.unit) }))
      .filter((x): x is { interp: (typeof cands)[number]; m: { value: number; at: number } } => x.m !== null)
      // 取文中位置最靠前的那个：结论在前，分项在后。
      .sort((a, b) => a.m.at - b.m.at);
    const matched = hits[0]?.interp;
    const expected = cands.map((i) => `${i.label} ${i.value}${input.unit ? ' ' + input.unit : ''}`).join(' / ');

    if (!matched) {
      return {
        hit: false,
        caveatOk: false,
        expected,
        detail: `未命中任何可接受口径（共 ${cands.length} 个）`,
      };
    }

    // 口径说明：优先用该口径自己的词；没配就退回题目级关键词；都没有则判不了（null）
    const kws = matched.keywords?.length ? matched.keywords : (input.caveatKeywords ?? []);
    const said = kws.length === 0 ? null : kws.some((k) => answer.includes(k));
    return {
      hit: true,
      caveatOk: said,
      expected,
      detail:
        `命中「${matched.label}」` +
        (hits.length > 1 ? `（${hits.length} 个口径的数都在答案里，取最靠前的）` : '') +
        (said === true ? '，且解释了该口径' : said === false ? '，但没解释口径（数字对、解释缺失）' : '，该口径无关键词、无法判说明'),
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
