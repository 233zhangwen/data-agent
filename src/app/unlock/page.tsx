import type { Metadata } from 'next';

import { safeNext } from '@/lib/passcode';
import { UnlockForm } from './UnlockForm';

export const metadata: Metadata = { title: '需要口令 · 数据问答 Agent' };

/** 口令页本身不烧 token，也不该被索引。 */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">这个 demo 需要口令</h1>
        <p className="text-sm text-zinc-500">
          每次提问都要调模型和数据库，所以它不对外开放。口令向作者索取。
        </p>
      </header>
      <UnlockForm next={safeNext(next)} />
      <p className="text-xs text-zinc-400">
        口令只存在你自己的浏览器里（httpOnly cookie，30 天），不会传给第三方。
      </p>
    </main>
  );
}
