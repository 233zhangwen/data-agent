import { describe, expect, it } from 'vitest';

import { buildChartSpec, ChartSpecError, type ChartParams } from '../../src/lib/chart';
import type { QueryResult } from '../../src/lib/agent-db';

function makeResult(
  columns: string[],
  rows: Record<string, unknown>[],
  extra: Partial<QueryResult> = {},
): QueryResult {
  return {
    columns,
    numericColumns: [],
    rows,
    rowCount: rows.length,
    truncated: false,
    elapsedMs: 5,
    ...extra,
  };
}

const salesByMonth = makeResult(
  ['month', 'gmv', 'channel_name'],
  [
    { month: '2026-01-01', gmv: 100, channel_name: '自然搜索' },
    { month: '2026-02-01', gmv: 150, channel_name: '付费广告' },
    { month: '2026-03-01', gmv: 120, channel_name: '转介绍' },
  ],
);

const params = (over: Partial<ChartParams> = {}): ChartParams => ({
  type: 'bar',
  xKey: 'month',
  yKey: 'gmv',
  ...over,
});

describe('buildChartSpec · 正常路径', () => {
  it('bar：参数合法时返回 spec，数据直接来自结果', () => {
    const spec = buildChartSpec(params({ title: '月度 GMV' }), salesByMonth);
    expect(spec.type).toBe('bar');
    expect(spec.title).toBe('月度 GMV');
    expect(spec.xKey).toBe('month');
    expect(spec.yKeys).toEqual(['gmv']);
    expect(spec.data).toHaveLength(3);
    expect(spec.data[0].gmv).toBe(100); // 数据原样，没经过任何改写
  });

  it('yKey 传字符串时归一成单元素数组', () => {
    const spec = buildChartSpec(params({ yKey: 'gmv' }), salesByMonth);
    expect(spec.yKeys).toEqual(['gmv']);
  });

  it('标题缺省时自动拼一个', () => {
    const spec = buildChartSpec(params({ title: undefined }), salesByMonth);
    expect(spec.title).toContain('month');
    expect(spec.title).toContain('gmv');
  });
});

describe('buildChartSpec · 校验（C9 的五条拒绝路径）', () => {
  it('列不存在 → 报错并列出全部可用列', () => {
    expect(() => buildChartSpec(params({ xKey: 'months' }), salesByMonth)).toThrow(
      /month、gmv、channel_name/,
    );
  });

  it('文本列当度量 → 报错并指出真正的数值列', () => {
    const e = (() => {
      try {
        buildChartSpec(params({ yKey: 'channel_name' }), salesByMonth);
      } catch (err) {
        return err as ChartSpecError;
      }
    })();
    expect(e).toBeInstanceOf(ChartSpecError);
    expect(e!.message).toContain('channel_name');
    expect(e!.message).toContain('gmv'); // 告诉它数值列是哪个
  });

  it('饼图多度量 → 拒绝并建议 bar', () => {
    expect(() =>
      buildChartSpec(params({ type: 'pie', yKey: ['gmv', 'channel_name'] }), salesByMonth),
    ).toThrow(/bar/);
  });

  it('折线图用非时间轴 → 拒绝', () => {
    expect(() =>
      buildChartSpec(params({ type: 'line', xKey: 'channel_name' }), salesByMonth),
    ).toThrow(/时间列/);
  });

  it('没有上一轮查询结果 → 拒绝并提示先 runSql', () => {
    expect(() => buildChartSpec(params(), null)).toThrow(/runSql/);
    expect(() => buildChartSpec(params(), makeResult(['a'], []))).toThrow(/0 行|没有可画/);
  });
});

describe('buildChartSpec · 边界', () => {
  it('数值列含 null 不算错（折线允许缺口），但全 null 的度量要拒绝', () => {
    const withNull = makeResult(['m', 'v'], [
      { m: '2026-01-01', v: 1 },
      { m: '2026-02-01', v: null },
    ]);
    expect(() =>
      buildChartSpec(params({ type: 'line', xKey: 'm', yKey: 'v' }), withNull),
    ).not.toThrow();

    const allNull = makeResult(['m', 'v'], [
      { m: '2026-01-01', v: null },
      { m: '2026-02-01', v: null },
    ]);
    expect(() => buildChartSpec(params({ type: 'line', xKey: 'm', yKey: 'v' }), allNull)).toThrow(
      /不是数字|v/,
    );
  });

  it('字符串数字可以当度量（SQL 的 numeric 在驱动层是字符串）', () => {
    const strNum = makeResult(['m', 'amount'], [
      { m: '2026-01-01', amount: '123.45' },
      { m: '2026-02-01', amount: '80' },
    ]);
    expect(() =>
      buildChartSpec(params({ type: 'line', xKey: 'm', yKey: 'amount' }), strNum),
    ).not.toThrow();
  });

  it('超过 200 个点截断，note 里说明', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ m: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, v: i }));
    const spec = buildChartSpec(params({ type: 'line', xKey: 'm', yKey: 'v' }), makeResult(['m', 'v'], rows));
    expect(spec.data).toHaveLength(200);
    expect(spec.note).toContain('500');
  });
});
