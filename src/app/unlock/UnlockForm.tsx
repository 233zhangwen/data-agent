'use client';

import { useActionState, useState } from 'react';

import { unlock, type UnlockState } from './actions';

/**
 * 口令输入框。
 *
 * 为什么是受控组件：React 19 的 `<form action={...}>` 在 action 结束后会
 * `form.reset()`，**不分成功失败**。非受控字段的表现是"输错一次，口令框被清空"，
 * 用户得重打一遍 —— 项目 #1 在删除/重命名表单上踩过这个坑（更糟的版本是
 * 静默失败被 reset 掩盖成"偶尔要点两下"）。这里把值和错误提示的清除都交给 state。
 */
export function UnlockForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<UnlockState, FormData>(unlock, { error: null });
  const [code, setCode] = useState('');

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm text-zinc-600">
        访问口令
        <input
          name="passcode"
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoComplete="current-password"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-zinc-500"
          placeholder="向作者索取"
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || code.trim().length === 0}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40"
      >
        {pending ? '校验中…' : '进入'}
      </button>
    </form>
  );
}
