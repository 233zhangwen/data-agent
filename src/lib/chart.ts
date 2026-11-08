/**
 * `make_chart` 工具的核心：把「上一轮 run_sql 的结果」变成 Recharts 能渲染的配置。
 *
 * 设计红线（docs/ACCEPTANCE-W2.md 1.2，已拍板）：**数据不经过模型的手**。
 * 模型只传 { type, title, xKey, yKey }，数据取自服务端记住的 lastResult。
 * 这样「SQL 错了」和「模型抄错了」永远分得清——后者在这个设计里不存在。
 *
 * 校验失败的返回必须**可用**：不是一句"参数错误"，而是列出全部可用列名、
 * 指出哪一列才是数值列。模型拿着这个信息一次就能改对。
 */

import type { QueryResult } from './agent-db';

export type ChartType = 'bar' | 'line' | 'pie';

export type ChartSpec = {
  type: ChartType;
  title: string;
  xKey: string;
  yKeys: string[];
  data: Record<string, unknown>[];
  /** 传给模型/前端的附注：数据是否被截断、来自哪条查询。 */
  note: string;
};

/** 校验失败。availableColumns 一起返回——错误信息要能直接指导下一步。 */
export class ChartSpecError extends Error {
  constructor(
    message: string,
    public readonly availableColumns?: string[],
  ) {
    super(message);
    this.name = 'ChartSpecError';
  }
}

const CHART_TYPES: ChartType[] = ['bar', 'line', 'pie'];

/** 图表数据点上限。SQL 结果上限是 1000 行，但折线图超过 200 个点只是噪声。 */
const MAX_POINTS = 200;

function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
  return false;
}

export type ChartParams = {
  type: string;
  title?: string;
  xKey: string;
  /** 允许传字符串或数组——模型经常只画一个度量。 */
  yKey: string | string[];
};

export function buildChartSpec(params: ChartParams, result: QueryResult | null): ChartSpec {
  // ---- 1. 有没有数据可画
  if (!result || result.rows.length === 0) {
    throw new ChartSpecError(
      '没有可画的数据。先用 runSql 查出结果，再调用本工具——它画的是你最近一次查询的结果。',
    );
  }

  // ---- 2. 图表类型
  if (!CHART_TYPES.includes(params.type as ChartType)) {
    throw new ChartSpecError(
      `图表类型必须是 ${CHART_TYPES.join(' / ')} 之一，收到的是「${params.type}」。`,
    );
  }
  const type = params.type as ChartType;

  const columns = result.columns;
  const columnList = `可用列：${columns.join('、')}`;

  // ---- 3. 轴列必须真实存在
  if (!columns.includes(params.xKey)) {
    throw new ChartSpecError(`xKey「${params.xKey}」不在查询结果里。${columnList}`, columns);
  }

  const yKeys = (Array.isArray(params.yKey) ? params.yKey : [params.yKey]).filter(Boolean);
  if (!yKeys.length) {
    throw new ChartSpecError(`yKey 至少要指定一列。${columnList}`, columns);
  }
  for (const k of yKeys) {
    if (!columns.includes(k)) {
      throw new ChartSpecError(`yKey「${k}」不在查询结果里。${columnList}`, columns);
    }
  }

  // ---- 4. 类型特有的约束（先于数值检查：错误要一个一个给，一次全给模型会漏看）
  if (type === 'pie' && yKeys.length > 1) {
    throw new ChartSpecError(
      `饼图表达的是占比，只能有一个度量列，收到 ${yKeys.length} 个。` +
        '要对比多个度量请用 bar。',
    );
  }

  if (type === 'line') {
    const sample = result.rows.find((r) => r[params.xKey] !== null)?.[params.xKey];
    if (sample !== undefined && !/^\d{4}-\d{2}/.test(String(sample))) {
      throw new ChartSpecError(
        `折线图要求 xKey 是时间列（值形如 2026-01-31），而「${params.xKey}」的值是「${sample}」。` +
          '非时间轴的对比请用 bar。',
      );
    }
  }

  // ---- 5. 度量列必须真是数值
  for (const k of yKeys) {
    const values = result.rows.map((r) => r[k]);
    if (values.every((v) => v === null || v === undefined)) {
      throw new ChartSpecError(
        `yKey「${k}」整列都是空值，画出来没有任何信息。${columnList}`,
        columns,
      );
    }
    const badIdx = values.findIndex((v) => v !== null && v !== undefined && !isNumeric(v));
    if (badIdx >= 0) {
      const numericCols = columns.filter((c) =>
        result.rows.some((r) => r[c] !== null && isNumeric(r[c])),
      );
      throw new ChartSpecError(
        `yKey「${k}」在第 ${badIdx + 1} 行的值是「${String(values[badIdx])}」，不是数字。` +
          `数值列有：${numericCols.join('、') || '（无）'}。`,
        columns,
      );
    }
  }

  const data = result.rows.slice(0, MAX_POINTS);
  const note =
    (result.truncated ? `源查询有 ${result.rowCount}+ 行，` : `源查询 ${result.rowCount} 行，`) +
    `图表取前 ${data.length} 行。${result.elapsedMs}ms 前执行的那条 SQL。`;

  return {
    type,
    title: params.title?.trim() || `${params.xKey} × ${yKeys.join(' / ')}`,
    xKey: params.xKey,
    yKeys,
    data,
    note,
  };
}

/** 给模型的报错文本：和 ChartSpecError 一起用，保证「失败也能自修」。 */
export function chartErrorForModel(e: unknown): string {
  if (e instanceof ChartSpecError) {
    return `图表参数有问题：${e.message} 修正参数后重试。`;
  }
  return e instanceof Error ? `生成图表失败：${e.message}` : '生成图表失败：未知错误';
}
