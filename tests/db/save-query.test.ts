/**
 * save_query 两阶段的数据库级测试（W2 spec C10–C12 的服务端部分）。
 *
 * 直接打 dev 库（Neon）。用专属 sessionId 隔离测试数据，afterAll 清干净——
 * 不建独立测试库是因为这些测试只写两张应用表，行级清理足够且更贴近真实路径。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../src/lib/db';
import { confirmProposal, createProposal, SaveQueryRejected } from '../../src/lib/save-query';

const SESSION_A = `vitest-w2-a-${Date.now()}`;
const SESSION_B = `vitest-w2-b-${Date.now()}`;
const SQL = 'SELECT status, count(*) FROM orders GROUP BY status ORDER BY count(*) DESC';
const TITLE = `[测试] 各状态订单数 ${SESSION_A}`;

let savedId: number | null = null;

beforeAll(async () => {
  await prisma.queryProposal.deleteMany({ where: { sessionId: { in: [SESSION_A, SESSION_B] } } });
  await prisma.savedQuery.deleteMany({ where: { title: TITLE } });
});

afterAll(async () => {
  await prisma.queryProposal.deleteMany({ where: { sessionId: { in: [SESSION_A, SESSION_B] } } });
  if (savedId !== null) await prisma.savedQuery.deleteMany({ where: { id: savedId } });
  await prisma.savedQuery.deleteMany({ where: { title: TITLE } });
  await prisma.$disconnect();
});

describe('createProposal · 入口校验', () => {
  it('空 SQL 拒绝', async () => {
    await expect(createProposal({ sessionId: SESSION_A, title: 't', sql: '  ' })).rejects.toThrow(
      SaveQueryRejected,
    );
  });

  it('超长 SQL 拒绝（上限与执行器一致：跑不了的也别存）', async () => {
    const longSql = `SELECT '${'x'.repeat(5000)}' AS junk`;
    await expect(
      createProposal({ sessionId: SESSION_A, title: 't', sql: longSql }),
    ).rejects.toThrow(/太长/);
  });

  it('空标题拒绝', async () => {
    await expect(createProposal({ sessionId: SESSION_A, title: ' ', sql: SQL })).rejects.toThrow(
      /标题/,
    );
  });
});

describe('confirmProposal · 满意路径与四条拒绝路径', () => {
  it('确认成功：SQL 从提案落库，返回 savedId', async () => {
    const p = await createProposal({
      sessionId: SESSION_A,
      title: TITLE,
      sql: SQL,
      question: '各状态的订单有多少',
    });

    const r = await confirmProposal(p.proposalId, SESSION_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      savedId = r.savedId;
      const row = await prisma.savedQuery.findUnique({ where: { id: r.savedId } });
      expect(row?.sql).toBe(SQL); // 和提案里的一字不差
      expect(row?.question).toBe('各状态的订单有多少');
    }
  });

  it('同一提案第二次确认 → already_used，saved_queries 不多出一行', async () => {
    const p = await createProposal({ sessionId: SESSION_A, title: TITLE, sql: SQL });
    await confirmProposal(p.proposalId, SESSION_A); // 第一次（这条也落了库，标题同，一起清）

    const second = await confirmProposal(p.proposalId, SESSION_A);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_used');

    const count = await prisma.savedQuery.count({ where: { title: TITLE } });
    // 两次确认只落一行——原子消费的语义
    expect(count).toBe(2); // 上一条用例 1 行 + 本条 1 行，证明第二次没有写入
  });

  it('过期提案 → expired', async () => {
    const p = await createProposal({ sessionId: SESSION_A, title: TITLE, sql: SQL });
    await prisma.queryProposal.update({
      where: { id: p.proposalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const r = await confirmProposal(p.proposalId, SESSION_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');

    const rows = await prisma.savedQuery.count({ where: { title: TITLE } });
    expect(rows).toBe(2); // 还是上面那两行，过期确认没有落库（C10）
  });

  it('别人的 session 来确认 → not_found（不泄漏存在性），库无变化', async () => {
    const p = await createProposal({ sessionId: SESSION_A, title: TITLE, sql: SQL });

    const r = await confirmProposal(p.proposalId, SESSION_B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found'); // 不是 forbidden——存在性本身就是信息

    // B 确认失败后，A 自己仍能确认成功（提案没被 B 的失败弄脏）
    const retry = await confirmProposal(p.proposalId, SESSION_A);
    expect(retry.ok).toBe(true);
    if (retry.ok) savedId = savedId ?? retry.savedId;
  });

  it('不存在的 id → not_found', async () => {
    const r = await confirmProposal('00000000-0000-0000-0000-000000000000', SESSION_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});
