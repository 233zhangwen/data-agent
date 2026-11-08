/**
 * 查询结果自带的「列合计」。
 *
 * 为什么要有这个东西（而不是再给模型一个 `verify_sum` 工具）：
 * 上一版给了 `verify_sum`（分项之和 vs 你给的合计），313 次运行里**一次都没被调用**。
 * 这是同一类错误的第三次复现：*提供了工具 ≠ 它会用*。收口第 2、3 层也是这个形状，
 * 区别在于那两层是**自动触发**的（到了最后一格工具就被关掉），而 verify_sum 需要
 * 模型自己想到"我可能算错了"——它想不到，因为它不知道自己错了。
 *
 * 所以换了个方向：**别要求它自检，把它要核对的那个数直接放在它眼前。**
 * D07 的真实失败是六行明细逐行都对、合计加错（547.9 万写成 563.6 万）。如果那次
 * 工具返回里就有一行"mrr 合计 5479000"，它需要做的是抄，而不是加。
 *
 * 三条边界（都写在这里而不是调用处，因为它们是语义而不是展示）：
 *   1. 只算数据库告知是数值类型的列（`numericColumns`），不靠猜
 *   2. 排除标识/时间刻度列（id / year / month …）—— 加了也没人会用它做分析，
 *      反而可能被当成"某个合计"引用
 *   3. 至少两个非 NULL 值才算；只有一个值时"合计"等于该值，是噪音
 *   4. **结果被截断时一律不算**（实测踩到：D07 那条 SQL 返回 1000 行被杀在
 *      MAX_ROWS 上，合计只加了前 1000 行，却会顶着"覆盖全部"的说法被当成总数引用。
 *      看起来权威的错数比没有数更坏 —— 宁可让它自己去 SQL 里 sum()）
 *
 * 纯函数，无 IO（tests/unit/column-totals.test.ts）。
 */

import { toScaled } from './calc';

const TEN = BigInt(10);

function pow10(k: number): bigint {
  return TEN ** BigInt(k);
}

/** 数据库数值类型（int2/4/8、float4/8、numeric）。money 也算，但本项目没用。 */
export const NUMERIC_TYPE_OIDS = new Set([20, 21, 23, 700, 701, 790, 1700]);

/** 看着是数值，但相加没意义的列名。 */
const NOT_SUMMABLE_NAME =
  /(^|_)(id|ids|year|month|day|week|quarter|hour|minute|second|no|seq|rank|row_num)$/i;

export type ColumnTotal = {
  column: string;
  /** 已格式化的合计值，可直接抄进答案。 */
  text: string;
  /** 参与相加的非 NULL 值个数。 */
  count: number;
};

/**
 * 一次最多给几列合计。多给不是更安全 —— 结果宽表里塞六行合计，
 * 模型反而容易把不相干列的合计当成本题答案。
 */
const MAX_COLUMNS = 6;

/** 展示小数位：金额场景两位够用。四位小数（numeric 除法的默认 scale）看着精确，其实只是噪音。 */
const MAX_DECIMALS = 2;

/**
 * 给结果算各数值列的合计。
 *
 * 任何一个非 NULL 值解析失败（比如数值列里混进了 'N/A'），就整列放弃 ——
 * 半对半错的合计比没有合计更危险。
 */
export function columnTotals(
  columns: string[],
  numericColumns: readonly string[],
  rows: readonly Record<string, unknown>[],
  opts: { truncated?: boolean } = {},
): ColumnTotal[] {
  if (opts.truncated) return [];
  if (rows.length < 2) return [];
  const numeric = new Set(numericColumns);
  const out: ColumnTotal[] = [];

  for (const column of columns) {
    if (out.length >= MAX_COLUMNS) break;
    if (!numeric.has(column)) continue;
    if (NOT_SUMMABLE_NAME.test(column)) continue;

    const raw = rows
      .map((r) => r[column])
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v));
    if (raw.length < 2) continue;

    let total: { n: bigint; s: number } | null = null;
    let ok = true;
    for (const v of raw) {
      let scaled: { n: bigint; s: number };
      try {
        scaled = toScaled(v);
      } catch {
        ok = false;
        break;
      }
      if (!total) {
        total = scaled;
        continue;
      }
      const s = Math.max(total.s, scaled.s);
      total = {
        n: total.n * pow10(s - total.s) + scaled.n * pow10(s - scaled.s),
        s,
      };
    }
    if (!ok || !total) continue;

    const decimals = Math.min(MAX_DECIMALS, total.s);
    out.push({ column, text: formatScaled(total, decimals), count: raw.length });
  }

  return out;
}

/** 定点数转字符串（四舍五入到 decimals 位，负数的四舍五入方向和正数一致）。 */
function formatScaled(v: { n: bigint; s: number }, decimals: number): string {
  const s = Math.max(v.s, decimals);
  let n = v.n * pow10(s - v.s);
  if (s > decimals) {
    const div = pow10(s - decimals);
    const neg = n < BigInt(0);
    const abs = neg ? -n : n;
    let q = abs / div;
    if ((abs % div) * BigInt(2) >= div) q = q + BigInt(1);
    n = neg ? -q : q;
  }
  const neg = n < BigInt(0);
  const digits = (neg ? -n : n).toString().padStart(decimals + 1, '0');
  const int = digits.slice(0, digits.length - decimals) || '0';
  // 去掉小数部分末尾多余的 0：547.90 → 547.9、4391283.00 → 4391283。
  // 保留它们只会让答案里凭空多出几位"看起来更精确"的数字。
  // ⚠️ 只能在小数部分上剥零 —— 对整串 `\.?0+$` 会先把 100 变成 1。
  const frac = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}
