'use client';

/**
 * 问答界面（W3 改为两栏）。
 *
 * 左栏：对话与答案（图表、保存确认卡片也在这里）——用户的视线主体。
 * 右栏：执行时间线 —— 每一次工具调用、入参、结果、耗时、失败原因。
 *
 * 为什么分栏而不是继续塞 `<details>`：这个项目的卖点是「全过程可见」，
 * 而折叠在消息流里的轨迹会把答案挤出屏幕，演示时就得来回滚。
 * 分栏之后「它怎么查的」和「它说了什么」同屏，这才是可展示的东西。
 *
 * 窄屏（<lg）退化为单栏：轨迹收进消息流下方的一个折叠块。
 *
 * 工具输出有两类需要特殊渲染，按**形状**识别而不是靠工具名：
 *   · makeChart 的图表配置 → Recharts 渲染（模型只填参数，渲染确定性）
 *   · saveQuery 的提案 → 确认卡片 → POST /api/saved-queries/confirm
 */

import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { useMemo, useRef, useState } from 'react';
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

const SERIES_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
const PIE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316'];

/** 工具输出里出现这些词 = 这次调用失败了（自修过程中的失败是正常且可见的）。 */
const FAIL_MARKERS = ['SQL 执行失败', '没被执行', '本轮已经失败', '报错', '不允许'];

// ---------------------------------------------------------------- 步骤抽取

type TraceStep = {
  key: string;
  name: string;
  input: unknown;
  output: unknown;
  done: boolean;
  failed: boolean;
};

/**
 * 从消息里抽出工具调用序列。只取最后一条 assistant 消息 = 最近一轮问答。
 *
 * 只做纯派生，不记录每步耗时：客户端拿不到单个工具的精确耗时（模型侧不返回），
 * 而 effect 里累积时间戳会被 react-hooks 规则拦（也确实会造成级联渲染）。
 * 「哪一步失败了」比「这步花了 800ms」重要，总耗时用 onFinish 记一次就够。
 */
function useTraceSteps(messages: UIMessage[]): TraceStep[] {
  return useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!last) return [];
    const out: TraceStep[] = [];
    last.parts.forEach((p, i) => {
      if (!p.type.startsWith('tool-')) return;
      const name = p.type.slice('tool-'.length);
      if (!(name in TOOL_LABEL)) return;
      const output = 'output' in p ? p.output : undefined;
      const done = output !== undefined;
      const text = typeof output === 'string' ? output : done ? JSON.stringify(output) : '';
      out.push({
        key: `${last.id}-${i}`,
        name,
        input: 'input' in p ? p.input : undefined,
        output,
        done,
        failed: done && FAIL_MARKERS.some((m) => text.includes(m)),
      });
    });
    return out;
  }, [messages]);
}

/** 一行结果摘要 —— 时间线里不展开 JSON，只给「发生了什么」的直觉。 */
function summarize(step: TraceStep): string {
  if (!step.done) return '执行中…';
  if (typeof step.output === 'string') {
    const first = step.output.split('\n').find((l) => l.trim()) ?? '';
    return first.length > 90 ? first.slice(0, 90) + '…' : first;
  }
  if (step.name === 'makeChart') return '图表配置已生成';
  if (step.name === 'saveQuery') return '提案已生成，等待确认';
  return JSON.stringify(step.output).slice(0, 90);
}

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
              <Pie data={spec.data} dataKey={spec.yKeys[0]} nameKey={spec.xKey} outerRadius={80} label={{ fontSize: 11 }}>
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
        <span className="ml-2 text-xs font-normal text-amber-600">{proposal.expiresInMin} 分钟内有效</span>
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

// ---------------------------------------------------------------- 时间线

function StepRow({ step, index }: { step: TraceStep; index: number }) {
  const [open, setOpen] = useState(false);
  const dot = step.failed
    ? 'bg-red-500'
    : !step.done
      ? 'bg-zinc-300 animate-pulse'
      : 'bg-emerald-500';

  return (
    <li className="relative pl-5" data-testid="trace-step">
      {/* 竖线：最后一步不画，避免尾巴悬空 */}
      <span className="absolute left-[3px] top-4 h-full w-px bg-zinc-200 last:hidden" aria-hidden />
      <span className={`absolute left-0 top-[6px] h-[7px] w-[7px] rounded-full ${dot}`} aria-hidden />

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left"
        aria-expanded={open}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] tabular-nums text-zinc-400">{index + 1}</span>
          <span className={`text-xs font-medium ${step.failed ? 'text-red-700' : 'text-zinc-800'}`}>
            {TOOL_LABEL[step.name] ?? step.name}
          </span>
        </div>
        <p className={`mt-0.5 line-clamp-2 text-[11px] leading-4 ${step.failed ? 'text-red-600' : 'text-zinc-500'}`}>
          {summarize(step)}
        </p>
      </button>

      {open ? (
        <div className="mt-1 mb-2 rounded-lg bg-zinc-50 p-2">
          <p className="text-[10px] font-medium text-zinc-400">入参</p>
          <pre className="mono max-h-32 overflow-auto whitespace-pre-wrap text-[10px] leading-4 text-zinc-600">
            {typeof step.input === 'string' ? step.input : JSON.stringify(step.input, null, 2)}
          </pre>
          {step.output !== undefined ? (
            <>
              <p className="mt-1 text-[10px] font-medium text-zinc-400">返回</p>
              <pre
                className={`mono max-h-40 overflow-auto whitespace-pre-wrap text-[10px] leading-4 ${
                  step.failed ? 'text-red-700' : 'text-zinc-700'
                }`}
              >
                {typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2)}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function TracePanel({ steps, busy, elapsed }: { steps: TraceStep[]; busy: boolean; elapsed: number | null }) {
  const failed = steps.filter((s) => s.failed).length;
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold text-zinc-700">执行轨迹</p>
        <p className="text-[10px] text-zinc-400">
          {steps.length ? `${steps.length} 步` : '—'}
          {failed ? ` · ${failed} 次失败` : ''}
          {busy ? ' · 进行中' : elapsed !== null ? ` · ${(elapsed / 1000).toFixed(1)}s` : ''}
        </p>
      </div>

      {steps.length === 0 ? (
        <p className="mt-3 text-[11px] leading-5 text-zinc-400">
          提问后这里会实时显示 Agent 的每一步：查了哪些表、写了什么 SQL、报错后又改成了什么。
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {steps.map((s, i) => (
            <StepRow key={s.key} step={s} index={i} />
          ))}
        </ol>
      )}

      {failed ? (
        <p className="mt-3 border-t border-zinc-100 pt-2 text-[10px] leading-4 text-zinc-500">
          红色是失败的尝试 —— 它们保留在轨迹里，因为「错了怎么改」比「一次就对」更能说明它靠不靠得住。
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 主面板

function isChartSpec(v: unknown): v is ChartSpecLike {
  return typeof v === 'object' && v !== null && 'type' in v && 'xKey' in v && 'yKeys' in v && 'data' in v;
}

function isProposal(v: unknown): v is ProposalLike {
  return typeof v === 'object' && v !== null && 'proposalId' in v && 'status' in v;
}

export function AskPanel() {
  const startRef = useRef(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const { messages, sendMessage, status, error } = useChat({
    // onFinish 是回调不是 effect，在这里 setState 是安全的
    onFinish: () => {
      if (startRef.current) setElapsed(Date.now() - startRef.current);
    },
  });
  const [input, setInput] = useState('');
  const steps = useTraceSteps(messages);

  const busy = status === 'submitted' || status === 'streaming';

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    startRef.current = Date.now();
    setElapsed(null);
    sendMessage({ text });
  }

  const inputBar = (
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
        placeholder="问点什么，比如：2026 年 10 月的 GMV 是多少？"
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
  );

  return (
    <div className="grid w-full flex-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左栏：对话 */}
      <div className="flex min-w-0 flex-col gap-4">
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

              if (!part.type.startsWith('tool-')) return null;
              const name = part.type.slice('tool-'.length);
              if (!(name in TOOL_LABEL)) return null;

              const output: unknown = 'output' in part ? part.output : undefined;

              // 两种需要「渲染成别的东西」的输出
              if (name === 'makeChart' && isChartSpec(output)) {
                return <ChartView key={key} spec={output} />;
              }
              if (name === 'saveQuery' && isProposal(output)) {
                return <SaveQueryCard key={key} proposal={output} />;
              }

              // 其余工具在左栏只留一行痕迹，细节看右栏 —— 答案不该被轨迹挤开
              const failed =
                typeof output === 'string' && FAIL_MARKERS.some((m) => output.includes(m));
              return (
                <p
                  key={key}
                  className={`pl-1 text-[11px] ${failed ? 'text-red-600' : 'text-zinc-400'}`}
                >
                  {failed ? '✕' : '→'} {TOOL_LABEL[name]}
                  {output === undefined ? ' · 执行中…' : ''}
                </p>
              );
            })}
          </div>
        ))}

        {error ? (
          <p
            data-testid="ask-error"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error.message || '请求失败'}
          </p>
        ) : null}

        {/* 窄屏：轨迹降级为折叠块 */}
        <details className="rounded-xl border border-zinc-200 bg-white lg:hidden">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-600">
            执行轨迹{steps.length ? `（${steps.length} 步${busy ? '，进行中' : ''}）` : ''}
          </summary>
          <div className="border-t border-zinc-100 p-2">
            <TracePanel steps={steps} busy={busy} elapsed={elapsed} />
          </div>
        </details>

        {inputBar}
      </div>

      {/* 右栏：轨迹（桌面端常驻） */}
      <aside className="sticky top-6 hidden lg:block">
        <TracePanel steps={steps} busy={busy} elapsed={elapsed} />
      </aside>
    </div>
  );
}
