'use client';

/**
 * 问答界面：对话流 + 每一次工具调用全程可见（W1）。
 * W2 新增两个「非文本」工具输出的渲染：
 *   · makeChart 的图表配置 → Recharts 前端渲染（拍板：模型只填参数，渲染确定性）
 *   · saveQuery 的提案 → 内联确认卡片 → POST /api/saved-queries/confirm（拍板：对话流内联）
 */

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

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

const SERIES_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
const PIE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316'];

// ---------------------------------------------------------------- 图表

type ChartSpecLike = {
  type: 'bar' | 'line' | 'pie';
  title: string;
  xKey: string;
  yKeys: string[];
  data: Record<string, unknown>[];
  note: string;
  loopWarning?: string;
};

function ChartView({ spec }: { spec: ChartSpecLike }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <p className="text-sm font-medium text-zinc-800">{spec.title}</p>
      <div className="mt-2 h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === 'bar' ? (
            <BarChart data={spec.data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey={spec.xKey} fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              {spec.yKeys.length > 1 ? <Legend /> : null}
              {spec.yKeys.map((k, i) => (
                <Bar key={k} dataKey={k} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
              ))}
            </BarChart>
          ) : spec.type === 'line' ? (
            <LineChart data={spec.data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey={spec.xKey} fontSize={11} />
              <YAxis fontSize={11} />
              <Tooltip />
              {spec.yKeys.length > 1 ? <Legend /> : null}
              {spec.yKeys.map((k, i) => (
                <Line
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          ) : (
            <PieChart>
              <Tooltip />
              <Pie
                data={spec.data}
                dataKey={spec.yKeys[0]}
                nameKey={spec.xKey}
                outerRadius={80}
                label={{ fontSize: 11 }}
              >
                {spec.data.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] text-zinc-400">
        {spec.note}
        {spec.loopWarning ? ` ${spec.loopWarning}` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- 保存确认卡片

type ProposalLike = {
  status: 'pending_confirmation';
  proposalId: string;
  title: string;
  sql: string;
  expiresInMin: number;
};

function SaveQueryCard({ proposal }: { proposal: ProposalLike }) {
  const [state, setState] = useState<'pending' | 'saving' | 'saved' | 'declined' | 'error'>('pending');
  const [errMsg, setErrMsg] = useState('');

  async function confirm() {
    setState('saving');
    try {
      // 只发 proposalId——服务端从库里读 SQL。确认请求里带 SQL 正是设计上禁止的。
      const res = await fetch('/api/saved-queries/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: proposal.proposalId }),
      });
      if (res.ok) {
        setState('saved');
      } else {
        const j = (await res.json()) as { error?: string };
        setErrMsg(j.error ?? `HTTP ${res.status}`);
        setState('error');
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : '网络错误');
      setState('error');
    }
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">
        确认保存查询：{proposal.title}
        <span className="ml-2 text-xs font-normal text-amber-600">
          {proposal.expiresInMin} 分钟内有效
        </span>
      </p>
      <pre className="mono mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-2 text-[11px] leading-5 text-zinc-700">
        {proposal.sql}
      </pre>

      {state === 'pending' || state === 'saving' ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-testid="confirm-save"
            onClick={confirm}
            disabled={state === 'saving'}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {state === 'saving' ? '保存中…' : '确认保存'}
          </button>
          <button
            type="button"
            onClick={() => setState('declined')}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-700"
          >
            不要了
          </button>
        </div>
      ) : state === 'saved' ? (
        <p data-testid="save-ok" className="mt-2 text-xs font-medium text-emerald-700">
          ✓ 已保存
        </p>
      ) : state === 'declined' ? (
        <p className="mt-2 text-xs text-zinc-500">已放弃，不会保存</p>
      ) : (
        <p data-testid="save-error" className="mt-2 text-xs text-red-700">
          保存失败：{errMsg}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 主面板

function isChartSpec(v: unknown): v is ChartSpecLike {
  return (
    typeof v === 'object' && v !== null && 'type' in v && 'xKey' in v && 'yKeys' in v && 'data' in v
  );
}

function isProposal(v: unknown): v is ProposalLike {
  return typeof v === 'object' && v !== null && 'proposalId' in v && 'status' in v;
}

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
                const output: unknown = 'output' in part ? part.output : undefined;
                const isSql = name === 'runSql';

                // 特殊工具输出：图表 / 保存提案（按形状识别，不靠工具名——更稳）
                if (name === 'makeChart' && isChartSpec(output)) {
                  return <ChartView key={key} spec={output} />;
                }
                if (name === 'saveQuery' && isProposal(output)) {
                  return <SaveQueryCard key={key} proposal={output} />;
                }

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
