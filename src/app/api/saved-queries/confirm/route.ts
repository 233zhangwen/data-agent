/**
 * 确认保存查询（两阶段的第二阶段）。
 *
 * 请求体只有 { proposalId } —— **不接收 SQL**。SQL 在阶段一就进了 query_proposals，
 * 这里凭 id 读出来落库。这个「缺一个字段」是整个设计的安全点：
 * 客户端能决定的只有「确认或不确认」，不能决定「确认什么」。
 *
 * 状态码：400 缺会话/参数 · 404 提案不存在（含错 session）· 410 过期 · 409 重复确认
 */

import { confirmProposal } from '@/lib/save-query';
import { readSessionId } from '@/lib/session-cookie';

export async function POST(req: Request) {
  const sessionId = readSessionId(req.headers.get('cookie'));
  if (!sessionId) {
    return Response.json({ error: '缺少会话标识，请刷新页面后重试' }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { proposalId?: unknown } | null;
  const proposalId = body?.proposalId;
  if (typeof proposalId !== 'string' || !proposalId || proposalId.length > 64) {
    return Response.json({ error: '缺少 proposalId' }, { status: 400 });
  }

  const result = await confirmProposal(proposalId, sessionId);

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'expired' ? 410 : 409;
    return Response.json({ error: result.message, reason: result.reason }, { status });
  }

  return Response.json({ id: result.savedId, title: result.title });
}
