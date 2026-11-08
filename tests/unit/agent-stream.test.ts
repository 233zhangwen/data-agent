/**
 * 收口兜底（src/lib/agent-stream.ts）单测 —— 喂假流，不调模型。
 *
 * 这里最要紧的一条是**分片顺序**：`finish` 必须最后发。兜底文本发在 finish 之后，
 * `toUIMessageStream` 会把它当成"说完之后的噪音"丢掉，表现是线上 UI 依然空白
 * ——那等于兜底写了但没人看见。所以顺序单独断言。
 */

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelUsage } from 'ai';

import {
  CANNED_WRAP_UP,
  readStream,
  toReadableStream,
  withWrapUp,
  type AgentStreamPart,
} from '@/lib/agent-stream';

function streamOf(parts: AgentStreamPart[]): ReadableStream<AgentStreamPart> {
  return new ReadableStream<AgentStreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

const src = (parts: AgentStreamPart[]) => ({ fullStream: streamOf(parts) });

async function collect(s: ReadableStream<AgentStreamPart>): Promise<AgentStreamPart[]> {
  const out: AgentStreamPart[] = [];
  for await (const p of readStream(s)) out.push(p);
  return out;
}

const finish = { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} } as AgentStreamPart;
const textOf = (parts: AgentStreamPart[]) =>
  parts.map((p) => (p.type === 'text-delta' ? p.text : '')).join('');

describe('withWrapUp', () => {
  it('有正文时不触发兜底，finish 保持最后', async () => {
    const wrapUp = vi.fn(async () => ({ text: '不该出现' }));
    const { stream, report, done } = withWrapUp(
      src([
        { type: 'text-start', id: 't1' } as AgentStreamPart,
        { type: 'text-delta', id: 't1', text: 'GMV 是 458.4 万' } as AgentStreamPart,
        { type: 'text-end', id: 't1' } as AgentStreamPart,
        finish,
      ]),
      wrapUp,
    );

    const parts = await collect(stream);
    await done;

    expect(wrapUp).not.toHaveBeenCalled();
    expect(report).toEqual({ wrappedUp: false, source: 'skipped' });
    expect(textOf(parts)).toBe('GMV 是 458.4 万');
    expect(parts[parts.length - 1].type).toBe('finish');
  });

  it('一个字都没说时补一段正文，且发在 finish 之前', async () => {
    const wrapUp = vi.fn(async () => ({ text: '结论：1589 人。' }));
    const { stream, report, done } = withWrapUp(
      src([{ type: 'tool-call', toolCallId: 'c1', toolName: 'runSql', input: {} } as AgentStreamPart, finish]),
      wrapUp,
    );

    const parts = await collect(stream);
    await done;

    expect(wrapUp).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ wrappedUp: true, source: 'model' });
    expect(textOf(parts)).toBe('结论：1589 人。');
    expect(parts[parts.length - 1].type).toBe('finish');
    // 兜底三段必须齐全，否则 UI 不会开气泡
    const kinds = parts.slice(-4).map((p) => p.type);
    expect(kinds).toEqual(['text-start', 'text-delta', 'text-end', 'finish']);
  });

  it('只有空白分片不算说过话', async () => {
    const wrapUp = vi.fn(async () => ({ text: '补一句' }));
    const { stream, report } = withWrapUp(
      src([{ type: 'text-delta', id: 't', text: '  \n' } as AgentStreamPart, finish]),
      wrapUp,
    );
    await collect(stream);
    expect(report.wrappedUp).toBe(true);
  });

  it('兜底调用失败 → 落固定文案，不是 500 也不是空白', async () => {
    const { stream, report } = withWrapUp(
      src([finish]), async () => {
      throw new Error('网络断了');
    });

    const parts = await collect(stream);
    expect(report).toMatchObject({ wrappedUp: true, source: 'canned' });
    expect(textOf(parts)).toBe(CANNED_WRAP_UP);
    expect(parts[parts.length - 1].type).toBe('finish');
  });

  it('兜底返回空串 → 也落固定文案', async () => {
    const { stream, report } = withWrapUp(
      src([finish]), async () => ({ text: '   ' }));
    await collect(stream);
    expect(report.source).toBe('canned');
  });

  it('兜底用量记进 report（否则 token 指标会漏算这一轮的成本）', async () => {
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 } as unknown as LanguageModelUsage;
    const { stream, report } = withWrapUp(
      src([finish]), async () => ({ text: '答案', usage }));
    await collect(stream);
    expect(report.extraUsage).toEqual(usage);
  });

  it('没有 finish 分片时不伪造（source 仍正常收流）', async () => {
    const { stream } = withWrapUp(
      src([{ type: 'text-delta', id: 't', text: '有正文' } as AgentStreamPart]), async () => ({
      text: 'x',
    }));
    const parts = await collect(stream);
    expect(parts.map((p) => p.type)).toEqual(['text-delta']);
  });
});

describe('toReadableStream', () => {
  it('生成器正常结束 → 流 close', async () => {
    async function* gen() {
      yield 1;
      yield 2;
    }
    const out: number[] = [];
    for await (const v of readStream(toReadableStream(gen()))) out.push(v);
    expect(out).toEqual([1, 2]);
  });
});
