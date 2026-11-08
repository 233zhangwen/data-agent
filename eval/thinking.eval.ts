/**
 * C15：验证 thinking: { type: 'disabled' } 注入是否真的生效。
 *
 * W1 遗留问题：流里有 reasoning-start/end 事件（内容加密），开关是否生效只能靠 token 数说话。
 * 同一问题各跑 3 次，比较 outputTokens（其中含 reasoningTokens 明细）。
 *
 * 判据：关闭态相对开启态，outputTokens 下降 ≥ 20%，或关闭态 reasoningTokens = 0。
 *
 * 注意 probe 的意外发现：即使注入 disabled，第一步（决定调什么工具）仍有 reasoning token。
 * 这个评测就是要量清楚它到底省了多少。
 */

import { describe, it } from 'vitest';

import { runTurn } from './harness';

const QUESTION = '2026 年 10 月的 GMV 是多少？排除已取消订单，实收口径。';

describe('C15 · thinking 开关的 token 对比', () => {
  it('同题各跑 3 次：disabled vs enabled', async () => {
    const runs: Record<'disabled' | 'enabled', { out: number; reason: number; total: number; elapsed: number }[]> = {
      disabled: [],
      enabled: [],
    };

    for (const mode of ['disabled', 'enabled'] as const) {
      for (let i = 0; i < 3; i++) {
        const r = await runTurn(QUESTION, { thinking: mode });
        runs[mode].push({
          out: r.usage.outputTokens,
          reason: r.usage.reasoningTokens,
          total: r.usage.totalTokens,
          elapsed: r.elapsedMs,
        });
        console.log(`${mode} #${i + 1}: output=${r.usage.outputTokens} reasoning=${r.usage.reasoningTokens} total=${r.usage.totalTokens} ${r.elapsedMs}ms`);
      }
    }

    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const outOff = avg(runs.disabled.map((r) => r.out));
    const outOn = avg(runs.enabled.map((r) => r.out));
    const reasonOff = avg(runs.disabled.map((r) => r.reason));
    const reasonOn = avg(runs.enabled.map((r) => r.reason));
    const drop = (outOn - outOff) / outOn;

    console.log(`\noutputTokens：disabled ${outOff.toFixed(0)} vs enabled ${outOn.toFixed(0)}（降 ${(drop * 100).toFixed(1)}%）`);
    console.log(`reasoningTokens：disabled ${reasonOff.toFixed(0)} vs enabled ${reasonOn.toFixed(0)}`);

    const verdict = reasonOff === 0 || drop >= 0.2;
    console.log(`C15 判定：${verdict ? '✓ 生效' : '✗ 未达门槛（降 ≥20% 或 reasoning=0）'}`);
  }, 600_000);
});
