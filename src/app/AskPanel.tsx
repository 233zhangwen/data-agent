'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

/** 工具名 → 中文标签。模型看到的是英文名，用户看到的是人话。 */
const TOOL_LABEL: Record<string, string> = {
  listTables: '看有哪些表',
  describeTable: '看表结构',
  runSql: '执行 SQL',
  searchSchema: '检索相关表',
  makeChart: '生成图表',
  saveQuery: '保存查询',
};

const TOOL_NAMES = Object.keys(TOOL_LABEL);

export function AskPanel() {
  const { messages, sendMessage, status, error } = useChat();
  const [input, setInput] = useState('');

  const busy = status === 'submitted' || status === 'streaming';

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    sendMessage({ text });
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-4">
        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-2">
            {message.parts.map((part, i) => {
              const key = `${message.id}-${i}`;

              if (part.type === 'text') {
                return (
                  <div
                    key={key}
                    className={
                      message.role === 'user'
                        ? 'self-end rounded-2xl bg-zinc-900 px-4 py-2 text-sm text-white'
                        : 'whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-3 text-sm leading-6 text-zinc-900'
                    }
                  >
                    {part.text}
                  </div>
                );
              }

              // 工具调用：agent 的每一次动作都摊开，不藏在黑箱里
              if (part.type.startsWith('tool-')) {
                const name = part.type.slice('tool-'.length);
                if (!TOOL_NAMES.includes(name)) return null;

                const input = 'input' in part ? part.input : undefined;
                const output = 'output' in part ? part.output : undefined;
                const isSql = name === 'runSql';

                return (
                  <details
                    key={key}
                    className="rounded-xl border border-zinc-200 bg-white text-xs"
                    open={isSql}
                  >
                    <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-700">
                      {TOOL_LABEL[name]}
                      {isSql && typeof input === 'object' && input && 'sql' in input ? (
                        <span className="ml-2 font-normal text-zinc-400">
                          {(input as { sql: string }).sql.slice(0, 60)}
                          {(input as { sql: string }).sql.length > 60 ? '…' : ''}
                        </span>
                      ) : null}
                    </summary>
                    <div className="border-t border-zinc-100 px-3 py-2">
                      <pre className="mono overflow-x-auto whitespace-pre-wrap text-[11px] leading-5 text-zinc-600">
                        {JSON.stringify(input, null, 2)}
                      </pre>
                      {output !== undefined ? (
                        <pre className="mono mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-t border-zinc-100 pt-2 text-[11px] leading-5 text-zinc-800">
                          {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
                        </pre>
                      ) : (
                        <p className="mt-2 text-zinc-400">执行中…</p>
                      )}
                    </div>
                  </details>
                );
              }

              return null;
            })}
          </div>
        ))}
      </div>

      {error ? (
        <p
          data-testid="ask-error"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error.message || '请求失败'}
        </p>
      ) : null}

      <div className="sticky bottom-4 flex gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm">
        <input
          data-testid="ask-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="问点什么，比如：上个月的 GMV 是多少？"
          className="flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-zinc-400"
        />
        <button
          data-testid="ask-send"
          type="button"
          onClick={submit}
          disabled={busy || !input.trim()}
          className="rounded-xl bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {busy ? '分析中…' : '提问'}
        </button>
      </div>
    </div>
  );
}
