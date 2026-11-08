/**
 * 空答案回归（W3 第 9 节）：只跑第六轮交白卷的那两条，验证收口三层有没有生效。
 *
 * 为什么单独留这一个 eval 而不是每次都跑 40 条：
 * 空答案是**低频高杀伤**的问题（5%），40 条全量跑一次 8 分钟、几十万 token，
 * 改一行提示词都想验一下的时候跑不起。这两条是已知最坏输入，两分钟能给出信号。
 *
 * 判据很窄，只看三件事：有没有正文、走了第几层收口、步数有没有超上限。
 *
 * 运行：`npm run eval:empty`
 */

import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runTurn } from './harness';

const CASES = [
  { id: 'B01', q: '买过硬件的客户里，有多少人后来订阅了 SaaS 服务？' },
  { id: 'D06', q: '客户流失率是多少？' },
];

describe('W3 · 空答案回归', () => {
  it('两条历史白卷题都必须给出正文', { timeout: 8 * 60 * 1000 }, async () => {
    const rows: string[] = [];

    for (const c of CASES) {
      const r = await runTurn(c.q);
      const layer = r.wrappedUp ? '兜底收口' : '主循环自答';
      rows.push(
        `${c.id} ${String(r.steps).padStart(2)}步/${String(r.tools.length).padStart(2)}次工具 ` +
          `${String(r.usage.totalTokens).padStart(6)}tok ` +
          `${String(r.elapsedMs).padStart(6)}ms ${layer} 正文 ${r.answer.length} 字`,
      );
      console.log(rows[rows.length - 1]);
      if (r.answer.length < 20) console.log(`   ⚠️ 正文过短：${JSON.stringify(r.answer)}`);

      expect(r.answer.trim().length, `${c.id} 仍然没有正文`).toBeGreaterThan(0);
    }

    fs.mkdirSync('eval/results', { recursive: true });
    fs.writeFileSync(
      'eval/results/empty-answer.txt',
      `ranAt=${new Date().toISOString()}\n${rows.join('\n')}\n`,
      'utf8',
    );
  });
});
