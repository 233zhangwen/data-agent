'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  checkPasscode,
  hashPasscode,
  PASSCODE_COOKIE,
  PASSCODE_MAX_AGE_SEC,
  safeNext,
} from '@/lib/passcode';

export type UnlockState = { error: string | null };

/**
 * 校验口令并下发 cookie。
 *
 * 两个细节：
 *   · 口令错的时候**返回错误状态而不是 redirect 回来** —— 重定向会丢掉用户刚输的内容，
 *     而 useActionState 的返回值能让表单保留输入（UnlockForm 是受控的，见那里的注释）。
 *   · redirect 必须放在 try/catch 之外：它靠抛异常实现，被 catch 住就成了"点了没反应"。
 *     项目 #1 在 Server Action 里踩过同类问题（外站跳转 + catch）。
 */
export async function unlock(_prev: UnlockState, formData: FormData): Promise<UnlockState> {
  const input = String(formData.get('passcode') ?? '');
  const next = safeNext(String(formData.get('next') ?? '/'));

  const expected = process.env.DEMO_PASSCODE;
  if (!expected) {
    return { error: '服务端没配置 DEMO_PASSCODE，无法解锁（本地开发不需要口令）。' };
  }

  if (!(await checkPasscode(input, expected))) {
    return { error: '口令不对。' };
  }

  const jar = await cookies();
  jar.set(PASSCODE_COOKIE, await hashPasscode(expected), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PASSCODE_MAX_AGE_SEC,
    // 本地 http 访问时 secure cookie 会被丢掉，所以只在生产开
    secure: process.env.NODE_ENV === 'production',
  });

  redirect(next);
}
