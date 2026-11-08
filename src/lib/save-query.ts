/**
 * `save_query` 两阶段确认的服务端实现（W2 spec 1.3）。
 *
 *   阶段一 createProposal：工具调用时把「想保存什么」写进 query_proposals，返回提案 id
 *   阶段二 confirmProposal：用户点确认后，凭 id 从库里读出 SQL 写进 saved_queries
 *
 * 三条设计红线（为什么确认端点安全）：
 *   1. 确认请求体里**没有 SQL**——客户端改了 SQL 再确认的路不存在；
 *   2. 单次消费靠条件更新（consumedAt 置位）在事务里完成，双击并发恰好一次成功；
 *   3. 提案绑 sessionId，且错 session 一律报 not_found——不泄漏「这个提案存在」。
 */

import { prisma } from './db';

/** 没人理的提案 10 分钟作废。 */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** 与 agent-db 的 MAX_SQL_LENGTH 同值：超长 SQL 本来就跑不了，也别存。 */
const MAX_SQL_LENGTH = 4000;
const MAX_TITLE = 120;
const MAX_QUESTION = 500;

export class SaveQueryRejected extends Error {
  constructor(
    message: string,
    public readonly kind: 'empty_sql' | 'too_long' | 'bad_title',
  ) {
    super(message);
    this.name = 'SaveQueryRejected';
  }
}

export type CreatedProposal = {
  proposalId: string;
  title: string;
  sql: string;
  /** 给模型看的提示文案（告诉用户「已生成待确认」时用）。 */
  expiresInMin: number;
};

export async function createProposal(input: {
  sessionId: string;
  title: string;
  sql: string;
  question?: string;
}): Promise<CreatedProposal> {
  const sql = input.sql?.trim() ?? '';
  if (!sql) throw new SaveQueryRejected('SQL 为空，没有可保存的内容', 'empty_sql');
  if (sql.length > MAX_SQL_LENGTH) {
    throw new SaveQueryRejected(
      `SQL 太长（${sql.length} 字符，上限 ${MAX_SQL_LENGTH}），不是一条可保存的分析查询`,
      'too_long',
    );
  }
  const title = input.title?.trim() ?? '';
  if (!title || title.length > MAX_TITLE) {
    throw new SaveQueryRejected(`标题必填且不超过 ${MAX_TITLE} 字`, 'bad_title');
  }

  const p = await prisma.queryProposal.create({
    data: {
      sessionId: input.sessionId,
      title,
      sql,
      question: (input.question ?? '').slice(0, MAX_QUESTION),
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    },
  });

  return { proposalId: p.id, title: p.title, sql: p.sql, expiresInMin: PROPOSAL_TTL_MS / 60000 };
}

export type ConfirmResult =
  | { ok: true; savedId: number; title: string }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'already_used';
      /** 给模型/前端的诊断文案。 */
      message: string;
    };

/**
 * 消费提案并落库。条件更新 + 插入在同一个事务里：
 * 「置位 consumedAt」是闸门，count===1 的请求才有资格写 saved_queries，
 * 崩溃恢复也安全——要么两步都发生，要么都没发生。
 */
export async function confirmProposal(
  proposalId: string,
  sessionId: string,
): Promise<ConfirmResult> {
  const now = new Date();

  const saved = await prisma.$transaction(async (tx) => {
    const r = await tx.queryProposal.updateMany({
      where: {
        id: proposalId,
        sessionId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (r.count !== 1) return null;

    // 闸门已过，SQL 从库里读——请求体里就算带了别的 SQL 也到不了这里
    const p = await tx.queryProposal.findUniqueOrThrow({ where: { id: proposalId } });
    const row = await tx.savedQuery.create({
      data: { title: p.title, sql: p.sql, question: p.question },
    });
    return row;
  });

  if (saved) return { ok: true, savedId: saved.id, title: saved.title };

  // 没消费成功 → 诊断原因。错 session 归入 not_found，不泄漏提案存在性。
  const p = await prisma.queryProposal.findUnique({ where: { id: proposalId } });
  if (!p || p.sessionId !== sessionId) {
    return { ok: false, reason: 'not_found', message: '没有这个待确认的提案（或已过期清理）' };
  }
  if (p.consumedAt) {
    return { ok: false, reason: 'already_used', message: '这条提案已经确认过，不能重复确认' };
  }
  if (p.expiresAt <= now) {
    return { ok: false, reason: 'expired', message: '提案已过期（10 分钟有效），请重新保存' };
  }
  return { ok: false, reason: 'not_found', message: '提案状态异常，请重新保存' };
}
