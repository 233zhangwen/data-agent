/** 一次性探针：确认 thinking 注入是否真的进了请求体（排除「中间件没生效」）。 */
import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import fs from 'fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; })
);

describe('probe: thinking 注入进请求体了吗', () => {
  it('log outgoing body', async () => {
    const bodies: string[] = [];
    const provider = createOpenAI({
      apiKey: env.LLM_API_KEY,
      baseURL: 'https://api.deepseek.com/v1',
      fetch: async (url, init) => {
        const b = JSON.parse(String(init?.body));
        b.thinking = { type: 'disabled' };
        b.reasoning_effort = 'none';   // 文档说这条能关 thinking mode
        const bodyStr = JSON.stringify(b);
        bodies.push(JSON.stringify({ thinking: b.thinking, model: b.model, len: bodyStr.length }));
        return fetch(url, { ...init, body: bodyStr });
      },
    });

    const r = streamText({
      model: provider('deepseek-flash'),
      prompt: '1+1=? 只回答数字',
      maxOutputTokens: 50,
    });
    await r.text;
    const u = await r.usage;
    console.log('发出的请求体（thinking 字段）:', bodies.join(' | '));
    console.log('usage:', JSON.stringify({ output: u.outputTokens, reasoning: u.outputTokenDetails?.reasoningTokens }));
    expect(bodies.length).toBeGreaterThan(0);
  }, 60_000);
});
