/**
 * 精确十进制算术：给 Agent 一个「不许心算」的出口。
 *
 * 起因是 ACCEPTANCE-W3 第 11 节 D07：模型把 6 行 MRR 拆分的明细全部查对了
 * （198.4 / 107.0 / 107.1 / 64.0 / 43.5 / 27.9 万），却在脑子里把它们加成了
 * **563.6 万**（真实 547.9 万），紧接着按套餐汇总又编出 312.8 / 176.4 / 74.3 万。
 * 正确答案从头到尾没有出现过。
 *
 * 关键判断：这类错误**不是浮点误差**，也不是"不够谨慎"。模型连浮点都没用 ——
 * 它是读了六个数字然后心算，而语言模型做多位数加法本来就不可靠。所以修法不是
 * 换个更精确的库，而是把这一步从模型脑子里搬出来，变成一次**可回显、可校验**
 * 的工具调用：算错了工具会当场告诉它差多少。
 *
 * 两个职责：
 *   1. compute —— 由分项算合计 / 差额 / 比率，替代心算
 *   2. verify  —— 核对自己已经给出的合计与分项是否一致，收口前自检
 *
 * 为什么用 BigInt 定点而不是 Number：0.1 + 0.2 那类误差在金额场景会以"差一分钱"
 * 的形式出现在报告里，事后极难归因。定点整数运算是可解释的 —— 每个数字都能
 * 还原成"整数 / 10^k"，读者能自己验算。
 *
 * 纯函数，无 IO，可单测（tests/unit/calc.test.ts）。
 */

export type CalcOp = 'sum' | 'diff' | 'product' | 'ratio' | 'pct_change' | 'avg' | 'verify_sum';

export type CalcInput = {
  op: CalcOp;
  /** 参与运算的数（verify_sum 时是分项）。允许字符串，会去掉千分位逗号和空格。 */
  values: (number | string)[];
  /** 仅 verify_sum：模型给出的合计，用于比对。 */
  expected?: number | string;
  /** 结果保留几位小数，默认 2。 */
  decimals?: number;
  /** 仅用于展示文案，如「万元」「%」「人」。不参与运算。 */
  unit?: string;
};

export type CalcResult =
  | { ok: true; value: number; display: string; detail: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------- 定点表示

/** 一个十进制数 = n / 10^s。所有运算都在这个表示上做。 */
type Scaled = { n: bigint; s: number };

const TEN = BigInt(10);

function pow10(k: number): bigint {
  return TEN ** BigInt(k);
}

/** 把 number / string 解析成定点表示。拒绝一切非纯数字（模型传 "198.4万" 时应当报错而不是猜）。 */
export function toScaled(x: number | string): Scaled {
  let raw: string;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new Error(`不是有效数字：${x}`);
    // 小到 1e-7 时 toString 会给科学计数法；金额场景不该出现，但别让它静默变成 NaN
    raw = Math.abs(x) < 1e-6 && x !== 0 ? x.toFixed(12) : String(x);
  } else {
    raw = x.replace(/[,，\s]/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`不是有效数字：「${x}」—— 只接受纯数字，单位请放到 unit 参数里`);
  }
  const neg = raw.startsWith('-');
  const body = neg ? raw.slice(1) : raw;
  const [intPart, fracPart = ''] = body.split('.');
  // 去掉前导零，但保留至少一位（BigInt('') 会抛）
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '') || '0';
  const s = fracPart.length;
  return { n: BigInt((neg ? '-' : '') + digits), s };
}

/** 对齐到相同 scale，便于加减。 */
function align(a: Scaled, b: Scaled): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}

/** BigInt 除法四舍五入（JS 的 `/` 是向零截断，正负都要处理）。 */
function roundDiv(num: bigint, den: bigint): bigint {
  if (den === BigInt(0)) throw new Error('除数为 0');
  const negative = num < BigInt(0) !== den < BigInt(0);
  const absNum = num < BigInt(0) ? -num : num;
  const absDen = den < BigInt(0) ? -den : den;
  const q = absNum / absDen;
  const r = absNum % absDen;
  const rounded = r * BigInt(2) >= absDen ? q + BigInt(1) : q;
  return negative ? -rounded : rounded;
}

/** a / b，保留 extra 位小数。 */
function divScaled(a: Scaled, b: Scaled, extra: number): Scaled {
  const num = a.n * pow10(b.s + extra);
  const den = b.n * pow10(a.s);
  return { n: roundDiv(num, den), s: extra };
}

/** 按 decimals 四舍五入并转回 number。 */
function finish(v: Scaled, decimals: number): number {
  const d = Math.max(0, Math.min(12, decimals));
  if (v.s <= d) return Number(v.n) * 10 ** (d - v.s) / 10 ** d;
  const q = roundDiv(v.n, pow10(v.s - d));
  return Number(q) / 10 ** d;
}

/** 数字转展示字符串：不加千分位（模型要读到的是可复制的数）。 */
function fmt(n: number, decimals: number): string {
  return n.toFixed(Math.max(0, Math.min(12, decimals)));
}

// ---------------------------------------------------------------- 运算

function sumAll(values: Scaled[]): Scaled {
  let acc: Scaled = { n: BigInt(0), s: 0 };
  for (const v of values) {
    const [a, b, s] = align(acc, v);
    acc = { n: a + b, s };
  }
  return acc;
}

/**
 * 计算并返回可读结果。
 *
 * 每一个 op 的 detail 都写成"算式 + 结果"，因为模型会把 detail 抄进答案 ——
 * 让它抄一个完整的算式，比让它记住一个孤零零的数字更不容易在转述时出错。
 */
export function calculate(input: CalcInput): CalcResult {
  const unit = input.unit ? ` ${input.unit}` : '';
  const decimals = input.decimals ?? 2;

  try {
    const values = (input.values ?? []).map(toScaled);
    if (!values.length) return { ok: false, error: 'values 不能为空' };

    switch (input.op) {
      case 'sum': {
        const total = sumAll(values);
        const v = finish(total, decimals);
        const plus = input.values.map((x) => String(x)).join(' + ');
        return {
          ok: true,
          value: v,
          display: `${fmt(v, decimals)}${unit}`,
          detail: `${plus} = ${fmt(v, decimals)}${unit}（共 ${values.length} 项）`,
        };
      }

      case 'avg': {
        const total = sumAll(values);
        const v = finish(divScaled(total, { n: BigInt(values.length), s: 0 }, decimals + 6), decimals);
        return {
          ok: true,
          value: v,
          display: `${fmt(v, decimals)}${unit}`,
          detail: `合计 ${fmt(finish(total, decimals + 4), decimals + 2)} ÷ ${values.length} 项 = ${fmt(v, decimals)}${unit}`,
        };
      }

      case 'diff': {
        if (values.length < 2) return { ok: false, error: 'diff 至少需要两个数：第一个是被减数' };
        const head = values[0];
        const rest = sumAll(values.slice(1));
        const [a, b, s] = align(head, rest);
        const v = finish({ n: a - b, s }, decimals);
        const tail = input.values.slice(1).map((x) => String(x)).join(' + ');
        return {
          ok: true,
          value: v,
          display: `${fmt(v, decimals)}${unit}`,
          detail: `${input.values[0]} - (${tail}) = ${fmt(v, decimals)}${unit}`,
        };
      }

      case 'product': {
        let acc: Scaled = { n: BigInt(1), s: 0 };
        for (const v of values) acc = { n: acc.n * v.n, s: acc.s + v.s };
        const v = finish(acc, decimals);
        return {
          ok: true,
          value: v,
          display: `${fmt(v, decimals)}${unit}`,
          detail: `${input.values.map((x) => String(x)).join(' × ')} = ${fmt(v, decimals)}${unit}`,
        };
      }

      case 'ratio': {
        if (values.length !== 2) return { ok: false, error: 'ratio 需要恰好两个数：前者 ÷ 后者' };
        const v = finish(divScaled(values[0], values[1], decimals + 6), decimals);
        return {
          ok: true,
          value: v,
          display: `${fmt(v, decimals)}${unit}`,
          detail: `${input.values[0]} ÷ ${input.values[1]} = ${fmt(v, decimals)}${unit}`,
        };
      }

      case 'pct_change': {
        if (values.length !== 2) return { ok: false, error: 'pct_change 需要恰好两个数：本期、基期' };
        // 差值：两个数 scale 不同，先通分再减，scale 相加是通分后的分母
        const delta: Scaled = {
          n: values[0].n * pow10(values[1].s) - values[1].n * pow10(values[0].s),
          s: values[0].s + values[1].s,
        };
        const ratio = divScaled(delta, values[1], decimals + 6);
        const pct = divScaled({ n: ratio.n * BigInt(100), s: ratio.s }, { n: BigInt(1), s: 0 }, decimals + 6);
        const v = finish(pct, decimals);
        const sign = v > 0 ? '+' : '';
        return {
          ok: true,
          value: v,
          display: `${sign}${fmt(v, decimals)}%`,
          detail: `(${input.values[0]} - ${input.values[1]}) ÷ ${input.values[1]} × 100% = ${sign}${fmt(v, decimals)}%`,
        };
      }

      case 'verify_sum': {
        if (input.expected === undefined || input.expected === null) {
          return { ok: false, error: 'verify_sum 需要 expected（你给出的合计）' };
        }
        const total = sumAll(values);
        const expected = toScaled(input.expected);
        const [a, b, s] = align(total, expected);
        const gapScaled = { n: a - b, s };
        const gap = finish(gapScaled, decimals);
        const sum = finish(total, decimals);
        const exp = finish(expected, decimals);

        if (b === BigInt(0)) {
          return { ok: true, value: sum, display: `${fmt(sum, decimals)}${unit}`, detail: `分项之和 ${fmt(sum, decimals)}${unit}` };
        }

        if (gapScaled.n === BigInt(0)) {
          return {
            ok: true,
            value: sum,
            display: `${fmt(sum, decimals)}${unit}`,
            detail: `一致：分项之和 = 你给的合计 = ${fmt(sum, decimals)}${unit}`,
          };
        }

        const pct = finish(divScaled(gapScaled, expected, decimals + 6), decimals + 1);
        return {
          ok: false,
          error:
            `**不一致**：分项之和 ${fmt(sum, decimals)}${unit}，你给的合计 ${fmt(exp, decimals)}${unit}，` +
            `差 ${fmt(gap, decimals)}${unit}（占 ${fmt(pct, decimals + 1)}%）。` +
            `请以分项之和为准；如果你确信合计对，说明有分项漏了或多算了，回去核对分项。`,
        };
      }

      default: {
        const never: never = input.op;
        return { ok: false, error: `不支持的 op：${String(never)}` };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '计算失败' };
  }
}

/**
 * 给模型的工具说明。写成常量是为了让 agent.ts 的描述与这里的实现同源 ——
 * 工具描述写错（比如说支持减号表达式）比不写更糟：模型会照着错的用法反复失败。
 */
export const CALC_DESCRIPTION =
  '做精确的十进制算术，替代心算。op 可选：sum（求和）/ avg（平均）/ diff（第一个减其余）/ ' +
  'product（连乘）/ ratio（前÷后）/ pct_change（本期对基期的百分比变化）/ ' +
  'verify_sum（把分项之和与你给出的合计比对）。' +
  '**凡是需要把多个已查出的数字合并成一个数，都用它算，不要自己心算** —— ' +
  '多位数加法会算错的。能由 SQL 聚合直接得出的，优先在 SQL 里算，不要拆成明细再相加。';
