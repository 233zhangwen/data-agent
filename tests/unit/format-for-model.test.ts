import { describe, expect, it } from 'vitest';

import type { QueryResult } from '@/lib/agent-db';
import { formatForModel } from '@/lib/agent';

/**
 * 这个函数是"模型眼里的世界"—— 它看到的每一行都决定它会不会算错。
 *
 * 单元测试它，是因为上一轮的关键结论**只能在这里验证**：verify_sum 那种
 * "让模型主动自检"的机制 313 次没被调用过；而"合计出现在工具返回里"这件事
 * 不依赖模型配合，可以逐字符断言。
 */

function result(partial: Partial<QueryResult> & Pick<QueryResult, 'columns' | 'rows'>): QueryResult {
  return {
    numericColumns: [],
    rowCount: partial.rows.length,
    truncated: false,
    elapsedMs: 3,
    ...partial,
  };
}

const SIX_ROWS = [
  { plan: '团队版-年付', mrr: '198.4' },
  { plan: '团队版-月付', mrr: '107.0' },
  { plan: '企业版-年付', mrr: '107.1' },
  { plan: '企业版-月付', mrr: '64.0' },
  { plan: '专业版-年付', mrr: '43.5' },
  { plan: '专业版-月付', mrr: '27.9' },
];

describe('列合计出现在工具返回里', () => {
  it('D07 场景：六行明细下面直接给出 547.9', () => {
    const text = formatForModel(
      result({
        columns: ['plan', 'mrr'],
        numericColumns: ['mrr'],
        rows: SIX_ROWS,
        rowCount: 6,
      }),
    );
    expect(text).toContain('列合计');
    expect(text).toContain('mrr 合计 = 547.9');
    expect(text).toContain('覆盖全部 6 行');
  });

  it('截断的结果**不给**合计（那是前 N 行的和，不是总数）', () => {
    const text = formatForModel(
      result({
        columns: ['plan', 'mrr'],
        numericColumns: ['mrr'],
        rows: SIX_ROWS,
        rowCount: 1000,
        truncated: true,
      }),
    );
    expect(text).not.toContain('列合计');
    expect(text).toContain('已截断');
  });

  it('断言里点明"不只是上表"——否则模型会拿 50 行去核对合计', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ mrr: '1.0', i }));
    const text = formatForModel(
      result({ columns: ['mrr'], numericColumns: ['mrr'], rows: many, rowCount: 80 }),
    );
    expect(text).toContain('不只是上表');
    expect(text).toContain('mrr 合计 = 80');
  });

  it('没有数值列时不多出这一段（不给模型添噪音）', () => {
    const text = formatForModel(
      result({ columns: ['plan'], rows: [{ plan: 'a' }, { plan: 'b' }] }),
    );
    expect(text).not.toContain('列合计');
  });

  it('0 行时说清"可能条件过严"，而不是给一张空表', () => {
    const text = formatForModel(result({ columns: ['mrr'], rows: [] }));
    expect(text).toContain('返回 0 行');
    expect(text).toContain('筛选条件');
  });
});
