/**
 * 冒烟测试：问一个问题，把 Agent 的执行轨迹和最终答案打出来。
 *
 * 为什么不只看"有没有回答"：Agent 最典型的失败是**看起来答了、但数字是编的**。
 * 所以这里把每一步的工具调用都摊开 —— 选了什么工具、SQL 长什么样、返回多少行。
 * 一眼能看出"答案是查出来的还是猜出来的"。
 *
 * 用法：
 *   node --experimental-transform-types scripts/smoke-ask.mts "订单总数是多少"
 *   node --experimental-transform-types scripts/smoke-ask.mts "上个月 GMV" --raw
 */

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';

const question = process.argv[2] ?? '订单总数是多少？';
const raw = process.argv.includes('--raw');

type ToolCall = { id: string; name: string; input: unknown; output?: string };

async function main() {
  const res = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'smoke-1', role: 'user', parts: [{ type: 'text', text: question }] }],
    }),
  });

  if (!res.ok || !res.body) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  const tools: ToolCall[] = [];
  const started = Date.now();
  let firstTokenAt = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE：事件之间用空行分隔，每行 data: {...}
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (raw) console.log(payload);

      switch (evt.type) {
        case 'text-delta': {
          if (!firstTokenAt) firstTokenAt = Date.now() - started;
          answer += String(evt.delta ?? '');
          break;
        }
        case 'tool-input-available': {
          tools.push({ id: String(evt.toolCallId), name: String(evt.toolName), input: evt.input });
          break;
        }
        case 'tool-output-available': {
          // 按 id 匹配：模型会在同一 step 里并行调多个工具（比如同时看 5 张表），
          // 按"最后一个"匹配会把输出贴到别的调用上，看起来像工具返回了空
          const target = tools.find((t) => t.id === String(evt.toolCallId));
          if (target) target.output = String(evt.output ?? '');
          break;
        }
        case 'error': {
          console.error('\n流内错误:', evt);
          break;
        }
      }
    }
  }

  const elapsed = Date.now() - started;

  console.log('问题：', question);
  console.log('─'.repeat(60));
  console.log(`工具调用 ${tools.length} 次：`);
  tools.forEach((t, i) => {
    const input = t.input as { sql?: string; table?: string } | undefined;
    const detail = input?.sql ?? input?.table ?? JSON.stringify(t.input);
    const outLines = (t.output ?? '').split('\n').length;
    console.log(`  ${i + 1}. ${t.name}  ${String(detail).replace(/\s+/g, ' ').slice(0, 100)}`);
    console.log(`     → ${outLines} 行输出，${(t.output ?? '').length} 字符`);
  });
  console.log('─'.repeat(60));
  console.log('答案：');
  console.log(answer.trim() || '（空）');
  console.log('─'.repeat(60));
  console.log(`耗时 ${elapsed}ms（首字 ${firstTokenAt || '-'}ms）`);
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
