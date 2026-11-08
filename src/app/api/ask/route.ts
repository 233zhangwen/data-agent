/**
 * 问答端点。
 *
 * 用 UI Message Stream 而不是纯文本流：前端 `useChat` 能拿到每一次工具调用
 * （工具名、入参、返回），"全程可见的执行轨迹"就是靠这个协议，不用自己发明事件格式。
 * 项目 #1 自己定义过一套 SSE 协议（因为当时只要文本），这里需求变了就换 ——
 * 同一类判断：**协议跟着需求走，不是跟着习惯走**。
 *
 * 会话 cookie（W2）：save_query 的提案要归属到某个浏览器会话（无登录项目的
 * 最小隔离）。没有 cookie 就发一个——Set-Cookie 挂在流式响应上。
 */

import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  toUIMessageStream,
  type UIMessage,
} from 'ai';

import { createDataAgent } from '@/lib/agent';
import { newSessionId, readSessionId, serializeSessionCookie } from '@/lib/session-cookie';

/** Agent 循环可能要跑十几秒（多次 SQL），给足函数执行时间。 */
export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: '缺少 messages' }, { status: 400 });
  }

  let sessionId = readSessionId(req.headers.get('cookie'));
  let setCookie: Record<string, string> | undefined;
  if (!sessionId) {
    sessionId = newSessionId();
    setCookie = { 'Set-Cookie': serializeSessionCookie(sessionId) };
  }

  const agent = createDataAgent({ sessionId });

  try {
    // ⚠️ stream() 是 async 的（返回 Promise<StreamTextResult>），必须 await ——
    // AI SDK 7 的 ToolLoopAgent.stream 与 streamText 的同步签名不同，这里踩过一次。
    const result = await agent.stream({
      messages: await convertToModelMessages(messages),
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
      headers: setCookie,
    });
  } catch (e) {
    // 配置类错误（缺 key、连不上库）在这里暴露，而不是变成一条"模型说它不知道"
    const message = e instanceof Error ? e.message : '未知错误';
    console.error('[ask] 启动失败', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
