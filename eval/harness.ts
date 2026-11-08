/**
 * 评测公用：直接调 createDataAgent（不经过 HTTP——dev server 必须由用户自己的
 * 终端跑，这是环境硬约定），把一轮问答的执行轨迹、token 用量、耗时收集成结构化结果。
 *
 * 运行方式：`npx vitest run eval/<name>.eval.ts` —— vitest 负责解析 TS 相对导入
 * 和注入 .env.local（tests/setup-env.ts），这是绕开「Node strip-types 不认无后缀
 * 相对导入」的通道，不为此改产品代码的 import 风格。
 *
 * fullStream 分片形状以 probe.eval.ts 实测为准：
 *   text-delta.text / tool-call{toolCallId,toolName,input} / tool-result{...,output}
 *   finish.totalUsage / await result.usage
 */

import { createDataAgent, type Faults } from '../src/lib/agent';
import { readStream, streamAgentTurn } from '../src/lib/agent-stream';

export type ToolStep = { id: string; name: string; input: unknown; output: string | object };

export type TurnResult = {
  question: string;
  answer: string;
  tools: ToolStep[];
  /** 实际跑了几步（= 几次模型调用）。步数上限是 MAX_STEPS，最后一格只作答。 */
  steps: number;
  /** runSql 报错次数（≈ 重试次数；L1 拦下的重复不算——它没执行）。 */
  sqlErrors: number;
  /** 最后一次真正执行的 runSql 是否成功。 */
  lastSqlOk: boolean;
  /** 是否走了兜底收口（步数用尽没说出话时补的那一次）。 */
  wrappedUp: boolean;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number };
  elapsedMs: number;
  firstTokenMs: number | null;
};

const SQL_FAIL_MARKERS = ['SQL 执行失败', '没被执行', '本轮已经失败'];

function isSqlFailOutput(out: string | object): boolean {
  if (typeof out !== 'string') return false;
  return SQL_FAIL_MARKERS.some((m) => out.includes(m));
}

export async function runTurn(
  question: string,
  opts: {
    sessionId?: string;
    faults?: Faults;
    evalFlags?: { disableL2?: boolean };
    thinking?: 'disabled' | 'enabled';
  } = {},
): Promise<TurnResult> {
  const agent = createDataAgent(opts);
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let answer = '';

  const tools: ToolStep[] = [];
  let steps = 0;
  let sqlErrors = 0;
  let lastSqlOk = false;

  // 走 agent-stream（与 /api/ask 同一条路径）：兜底收口也是产品行为，
  // 评测必须看见它，否则"空答案率 0"在线上不成立。
  const turn = await streamAgentTurn(agent, {
    messages: [{ role: 'user' as const, content: question }],
  });

  for await (const part of readStream(turn.stream)) {
    switch (part.type) {
      case 'start-step': {
        steps += 1;
        break;
      }
      case 'text-delta': {
        if (firstTokenMs === null) firstTokenMs = Date.now() - started;
        answer += part.text;
        break;
      }
      case 'tool-call': {
        // DEBUG_TOOLS=1 时把工具入参打到日志：回答「calc 的哪个 op 真的被用了」。
        // 这条日志当初就是为了查 verify_sum 到底有没有被调用（结论：0 次，已删除）。
        if (process.env.DEBUG_TOOLS) {
          console.log(`[tool] ${String(part.toolName)} ${JSON.stringify(part.input)}`);
        }
        tools.push({
          id: String(part.toolCallId),
          name: String(part.toolName),
          input: part.input,
          output: '',
        });
        break;
      }
      case 'tool-result': {
        const target = tools.find((t) => t.id === String(part.toolCallId));
        if (target) target.output = part.output as string | object;

        if (String(part.toolName) === 'runSql') {
          const out = part.output as string | object;
          if (isSqlFailOutput(out)) sqlErrors += 1;
          lastSqlOk = !isSqlFailOutput(out);
        }
        break;
      }
      default:
        break;
    }
  }

  const usage = await turn.usage;
  return {
    question,
    answer: answer.trim(),
    tools,
    steps,
    sqlErrors,
    lastSqlOk,
    wrappedUp: turn.report.wrappedUp,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
    elapsedMs: Date.now() - started,
    firstTokenMs,
  };
}

/** 修复成功的操作性定义：至少撞过一次错，且最后一条真正执行的 SQL 是成功的，且给了非空回答。 */
export function repaired(r: TurnResult): boolean {
  const executed = r.tools.filter((t) => t.name === 'runSql' && t.output !== '');
  return r.sqlErrors >= 1 && executed.length >= 1 && r.lastSqlOk && r.answer.length > 0;
}
