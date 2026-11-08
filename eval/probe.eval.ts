/**
 * 探针：跑一轮真实问答，打印 fullStream 每种分片的形状。
 * harness.ts 的解析逻辑以这里的实测为准，不凭记忆写。
 */

import { describe, it } from 'vitest';

import { createDataAgent } from '../src/lib/agent';

describe('probe fullStream shapes', () => {
  it('dump', async () => {
    const agent = createDataAgent();
    const result = await agent.stream({
      messages: [{ role: 'user' as const, content: '数据库里订单表一共有多少行？只查这一个数字。' }],
    });

    const seen = new Map<string, unknown[]>();
    for await (const part of result.fullStream) {
      const arr = seen.get(part.type) ?? [];
      if (arr.length < 2) arr.push(part);
      seen.set(part.type, arr);
    }

    for (const [type, samples] of seen) {
      console.log(`\n=== ${type} (${samples.length} 样本) ===`);
      for (const s of samples) {
        console.log(JSON.stringify(s).slice(0, 400));
      }
    }

    const usage = await result.usage;
    console.log('\n=== usage ===');
    console.log(JSON.stringify(usage));
  }, 120_000);
});
