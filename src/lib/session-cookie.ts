/**
 * 会话标识 cookie。项目没有登录（W1 spec 显式不做），但 save_query 的提案
 * 需要最小隔离——不为安全（uuid 本身已不可猜），为的是「两个浏览器窗口别串」。
 */

import crypto from 'crypto';

export const SESSION_COOKIE = 'data_agent_sid';

const MAX_AGE = 60 * 60 * 24 * 365;

export function readSessionId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      const v = part.slice(idx + 1).trim();
      // 形状约束：uuid 长度级别，防止有人拿它当存储用
      if (v && v.length <= 64 && /^[\w-]+$/.test(v)) return v;
      return null;
    }
  }
  return null;
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function serializeSessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
