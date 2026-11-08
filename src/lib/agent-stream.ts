/**
 * 收口兜底层（W3 第 9 节第 3 层）：主循环跑完仍没有一句正文时的兜底。
 *
 * 三层分工（前两层在 agent.ts + step-budget.ts）：
 *   1. 预算透明 —— 每步告诉模型还剩几步。
 *   2. 最后一格关工具 —— 剩 1 步时 toolChoice:'none'，模型只能写字。
 *   3. 本文 —— 万一还是空的（provider 空响应、内容被截断），再补一次**不带工具**的
 *      调用，让它基于已有查询结果收口；连这次也失败，才落到固定文案。
 *
 * 为什么兜底要真的再问一次模型、而不是直接显示"抱歉我没查出来"：
 * 空答案的两种成因完全不是一回事。步数用尽时，**数据其实已经查到了**，缺的只是
 * 让人把它写成结论；对用户来说，"查到了但没说"和"没查到"是两种体验，前者补一句话
 * 就能救回来。固定文案解决不了 5% 里的大多数。
 *
 * `withWrapUp` 是纯流变换（不碰模型），单测可以直接喂假流；
 * `streamAgentTurn` 负责把真实 agent 和真实模型接起来。
 */

import {
  generateText,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai';

import { createDataAgent, getChatModel } from './agent';

/** 评测与日志里用来统计"这一轮走了兜底"。 */
export type WrapUpReport = {
  wrappedUp: boolean;
  /** model = 兜底调用真的产出了答案；canned = 连兜底都空，用固定文案；skipped = 正常作答。 */
  source: 'model' | 'canned' | 'skipped';
  /** 兜底那一次调用的用量，要计进本轮成本（不然 token 指标会漏算）。 */
  extraUsage?: LanguageModelUsage;
};

export type WrapUpResult = { text: string; usage?: LanguageModelUsage };
export type WrapUpFn = () => Promise<WrapUpResult>;

export const WRAP_UP_INSTRUCTIONS = `这一轮的工具预算已经用完，现在**只能**根据上面已经执行过的查询结果回答用户。

要求：
- 先给结论和关键数字。数字只能来自已经执行过的查询结果，禁止推测或补全。
- 已有结果不足以回答时，明确说明：查到了什么、还缺什么。
- 不要描述你接下来打算做什么，不要写"我应该去查……"，也不要道歉式空话。
- 用中文；金额超过一万用「万」并保留一位小数；涉及时间范围时写出具体区间。`;

export const CANNED_WRAP_UP =
  '这次没能在步数预算内得出结论。查询实际执行过，但模型没有输出答案 —— ' +
  '可以点开右侧执行轨迹看已经查到哪一步，或者把问题问得更具体一些重试。';

const WRAP_UP_ID = 'wrap-up';

/** 对外暴露的分片类型：不绑定具体工具集（调用方只关心 type 与字段）。 */
export type AgentStreamPart = TextStreamPart<ToolSet>;

/** 把 async 生成器适配成 ReadableStream（toUIMessageStream 只认 ReadableStream）。 */
export function toReadableStream<T>(iter: AsyncIterable<T>): ReadableStream<T> {
  const it = iter[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/**
 * ReadableStream → 分片迭代器。
 * TS 的 ReadableStream 类型没声明 `[Symbol.asyncIterator]`，直接 for-await 会被拒；
 * 与其在调用点写 `as unknown as`，不如在这里收口一次。
 */
export async function* readStream<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 包一层流：正文分片原样透传；到头一个字都没有时，调 `wrapUp` 补一段正文再收尾。
 *
 * `finish` 分片要**扣住最后再发** —— 它带着 finishReason 与总用量，
 * 提前发出去等于告诉客户端"说完了"，兜底那段就会被丢掉（实际踩过：UI 上文字不出现）。
 *
 * `report` 是可变对象，消费完流之后读它（流式 API 没有"返回值"这一说）；
 * `done` 在流真正结束时 resolve，用它给 usage 排序。
 */
export function withWrapUp(
  source: { fullStream: ReadableStream<AgentStreamPart> },
  wrapUp: WrapUpFn,
  report: WrapUpReport = { wrappedUp: false, source: 'skipped' },
): { stream: ReadableStream<AgentStreamPart>; report: WrapUpReport; done: Promise<void> } {
  const reader = source.fullStream.getReader();
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  async function* parts(): AsyncGenerator<AgentStreamPart> {
    let sawText = false;
    let held: AgentStreamPart | null = null;
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        const part = value as AgentStreamPart;
        if (part.type === 'text-delta' && part.text.trim().length > 0) sawText = true;
        if (part.type === 'finish') {
          held = part;
          continue;
        }
        yield part;
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawText) {
      let text = CANNED_WRAP_UP;
      let sourceKind: WrapUpReport['source'] = 'canned';
      let usage: LanguageModelUsage | undefined;
      try {
        const r = await wrapUp();
        if (r.text.trim()) {
          text = r.text.trim();
          sourceKind = 'model';
          usage = r.usage;
        }
      } catch (e) {
        // 兜底本身失败（网络/额度）不该让整轮变成 500：用户已经等了几十秒，
        // 至少把"查到哪一步"告诉他。
        console.error('[wrap-up] 收口调用失败', e instanceof Error ? e.message : e);
      }

      report.wrappedUp = true;
      report.source = sourceKind;
      report.extraUsage = usage;

      yield { type: 'text-start', id: WRAP_UP_ID } as AgentStreamPart;
      yield { type: 'text-delta', id: WRAP_UP_ID, text } as AgentStreamPart;
      yield { type: 'text-end', id: WRAP_UP_ID } as AgentStreamPart;
    }

    if (held) yield held;
    resolveDone();
  }

  return { stream: toReadableStream(parts()), report, done };
}

// ---------------------------------------------------------------- 真实接线

type Agent = ReturnType<typeof createDataAgent>;
type AgentStreamResult = Awaited<ReturnType<Agent['stream']>>;

/**
 * 兜底收口：不带工具再问一次，上下文取「用户问题 + 最后两步的响应消息」。
 *
 * 只取最后两步而不是整段轨迹：B01 那类失败一轮就有 45k input token，全量重投
 * 既慢又贵，而最后两步已经包含最新一次查询结果——恰恰是最该用来作答的东西。
 * 按 step 切而不是按 message 切，是为了不切断 tool_call 与 tool_result 的配对
 * （配不上对会直接 400）。
 */
async function makeDefaultWrapUp(
  result: AgentStreamResult,
  messages: ModelMessage[],
  thinking: 'disabled' | 'enabled',
): Promise<WrapUpResult> {
  const steps = await result.steps;
  const tail = steps.slice(-2).flatMap((s) => s.response.messages);

  const r = await generateText({
    model: getChatModel(thinking),
    instructions: WRAP_UP_INSTRUCTIONS,
    messages: [...messages, ...tail],
  });
  return { text: r.text, usage: r.usage };
}

function sumUsage(a: LanguageModelUsage, b: LanguageModelUsage | undefined): LanguageModelUsage {
  if (!b) return a;
  const add = (x: number | undefined, y: number | undefined) => (x ?? 0) + (y ?? 0);
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      noCacheTokens: add(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: add(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: add(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokenDetails: {
      textTokens: add(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens),
      reasoningTokens: add(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens),
    },
  };
}

export async function streamAgentTurn(
  agent: Agent,
  params: { messages: ModelMessage[] },
  opts: { thinking?: 'disabled' | 'enabled'; wrapUp?: WrapUpFn } = {},
): Promise<{
  stream: ReadableStream<AgentStreamPart>;
  report: WrapUpReport;
  /** 主循环 + 兜底收口的合计用量。流消费完之后 await 它。 */
  usage: Promise<LanguageModelUsage>;
}> {
  const result = await agent.stream(params);
  const wrapUp =
    opts.wrapUp ?? (() => makeDefaultWrapUp(result, params.messages, opts.thinking ?? 'disabled'));

  const { stream, report, done } = withWrapUp(result, wrapUp);

  const usage = (async () => {
    const main = await result.usage;
    await done;
    return sumUsage(main, report.extraUsage);
  })();

  return { stream, report, usage };
}
