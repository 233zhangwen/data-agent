/**
 * 确认端点的 HTTP 级测试（C10–C12）。直接调用 route handler，
 * 不需要 dev server（环境约定：server 只在用户自己的终端跑）。
 *
 * 重点覆盖 C12：请求体里带 sql 字段时必须被**忽略**——
 * 落库的永远是提案里那条。这是两阶段设计的安全点，必须实测而不是"设计上不应该"。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST } from '../../src/app/api/saved-queries/confirm/route';
import { prisma } from '../../src/lib/db';
import { createProposal } from '../../src/lib/save-query';

const SESSION = `vitest-w2-route-${Date.now()}`;
const TITLE = `[测试] 端点级 ${SESSION}`;
const SQL = 'SELECT status, count(*) FROM orders GROUP BY status';

const createdIds: number[] = [];

function req(body: unknown, cookie: string | null = `data_agent_sid=${SESSION}`): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('http://localhost/api/saved-queries/confirm', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await prisma.queryProposal.deleteMany({ where: { sessionId: SESSION } });
  await prisma.savedQuery.deleteMany({ where: { title: TITLE } });
});

afterAll(async () => {
  await prisma.queryProposal.deleteMany({ where: { sessionId: SESSION } });
  for (const id of createdIds) await prisma.savedQuery.deleteMany({ where: { id } });
  await prisma.savedQuery.deleteMany({ where: { title: TITLE } });
  await prisma.$disconnect();
});

describe('POST /api/saved-queries/confirm', () => {
  it('C10 · 只有提案、未确认时 saved_queries 里查不到', async () => {
    const p = await createProposal({ sessionId: SESSION, title: TITLE, sql: SQL });
    const rows = await prisma.savedQuery.count({ where: { title: TITLE } });
    expect(rows).toBe(0);
    expect(p.proposalId).toBeTruthy();
  });

  it('C11 · 确认后落库；同一提案再确认返回 409', async () => {
    const p = await createProposal({ sessionId: SESSION, title: TITLE, sql: SQL });

    const res1 = await POST(req({ proposalId: p.proposalId }));
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { id: number };
    createdIds.push(body1.id);

    const res2 = await POST(req({ proposalId: p.proposalId }));
    expect(res2.status).toBe(409);

    const rows = await prisma.savedQuery.count({ where: { title: TITLE } });
    expect(rows).toBe(1); // 两次确认只落一行
  });

  it('C12 · 请求体里塞 sql → 被忽略，落库的是提案里那条', async () => {
    const p = await createProposal({ sessionId: SESSION, title: TITLE, sql: SQL });

    const res = await POST(
      req({ proposalId: p.proposalId, sql: 'DELETE FROM orders; DROP TABLE customers' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    createdIds.push(body.id);

    const row = await prisma.savedQuery.findUnique({ where: { id: body.id } });
    expect(row?.sql).toBe(SQL);
    expect(row?.sql).not.toContain('DROP');
  });

  it('没有会话 cookie → 400', async () => {
    const p = await createProposal({ sessionId: SESSION, title: TITLE, sql: SQL });
    const res = await POST(req({ proposalId: p.proposalId }, null));
    expect(res.status).toBe(400);
  });

  it('缺少 proposalId / 类型不对 → 400', async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ proposalId: 123 }))).status).toBe(400);
  });

  it('不存在的 id → 404；别人的 session → 404（不泄漏存在性）', async () => {
    expect((await POST(req({ proposalId: 'no-such-id' }))).status).toBe(404);

    const p = await createProposal({ sessionId: SESSION, title: TITLE, sql: SQL });
    const res = await POST(req({ proposalId: p.proposalId }, 'data_agent_sid=someone-else'));
    expect(res.status).toBe(404);
  });
});
