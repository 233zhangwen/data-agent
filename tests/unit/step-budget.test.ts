/**
 * 步数预算（src/lib/step-budget.ts）单测。
 *
 * 这套逻辑的价值不在"算得对"（就是减法），而在**边界位置**：哪一步开始收口、
 * 哪一步必须作答。算错一步的表现是"模型还有话说但工具没了"，很难在评测里看出来
 * ——所以用单测把边界钉死。
 */

import { describe, expect, it } from 'vitest';

import { MUST_ANSWER_NOTICE, planStep } from '@/lib/step-budget';

describe('planStep 边界', () => {
  it('第一步给出完整预算，且不禁用工具', () => {
    const p = planStep(0, 10);
    expect(p.remaining).toBe(10);
    expect(p.mustAnswer).toBe(false);
    expect(p.notice).toContain('第 1/10 步');
    expect(p.notice).toContain('还剩 10 步');
  });

  it('只剩 1 步时强制作答（工具关闭）', () => {
    const p = planStep(9, 10);
    expect(p.remaining).toBe(1);
    expect(p.mustAnswer).toBe(true);
    expect(p.notice).toBe(MUST_ANSWER_NOTICE);
  });

  it('只剩 2 步时提示"下一步必须作答"，但不关工具', () => {
    const p = planStep(8, 10);
    expect(p.remaining).toBe(2);
    expect(p.mustAnswer).toBe(false);
    expect(p.notice).toContain('只剩 2 步');
    expect(p.notice).toContain('必须作答');
  });

  it('过半（第 6 步起）提示停止开新方向', () => {
    expect(planStep(4, 10).notice).not.toContain('已过半');
    expect(planStep(5, 10).notice).toContain('已过半'); // ceil(10/2)=5
  });

  it('剩余步数严格递减', () => {
    const rem = Array.from({ length: 10 }, (_, i) => planStep(i, 10).remaining);
    expect(rem).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('mustAnswer 有且只有最后一步为 true（多种 maxSteps）', () => {
    for (const max of [1, 2, 3, 10, 21]) {
      const flags = Array.from({ length: max }, (_, i) => planStep(i, max).mustAnswer);
      expect(flags.filter(Boolean)).toHaveLength(1);
      expect(flags[flags.length - 1]).toBe(true);
    }
  });

  it('maxSteps=1 时第一步就收口（没有工具步）', () => {
    const p = planStep(0, 1);
    expect(p.mustAnswer).toBe(true);
    expect(p.remaining).toBe(1);
  });

  it('越界/非法输入不炸也不乱报', () => {
    expect(planStep(-3, 10).stepNumber).toBe(0);
    // 越过上限（理论上不会发生，但 SDK 换算法时不该抛）→ 仍然走收口语
    expect(planStep(99, 10).mustAnswer).toBe(true);
    expect(() => planStep(0, 0)).toThrow(/maxSteps/);
  });
});
