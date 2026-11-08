/**
 * 步数预算与收口（W3 第 9 节，修 5% 空答案）。
 *
 * 问题不是"步数不够"，是**循环到顶时是硬停**：最后一步如果是工具调用，模型就再也
 * 没有机会说话，用户拿到一个空气泡。第六轮 40 条里 2 条正是这样——B01 跑了 14 次
 * 工具、45k token，答案为空；D06 只留下一句"我先看一下有哪些表"。
 *
 * 所以这里做的不是把 MAX_STEPS 调大（那只是把阈值往后推），而是两件事：
 *
 *   1. **预算透明**：每一步都告诉模型还剩几步。模型不知道预算时会把 21 张表
 *      一张张 describe 完；知道"还剩 2 步"时它会先答。
 *   2. **最后一格留给作答**：剩 1 步时把 toolChoice 设成 'none'，工具物理关闭，
 *      模型只能写字。代价是可用工具步数从 10 降到 9——换来"永不交白卷"。
 *      这笔交换值得：一个不肯交卷的分析师，前面查得再对也等于没查。
 *
 * 纯函数，无 IO，可单测（tests/unit/step-budget.test.ts）。
 */

export type StepPlan = {
  /** 0 基的步骤序号（与 AI SDK prepareStep 的 stepNumber 同义）。 */
  stepNumber: number;
  /** 执行这一步时还剩几步（含这一步）。 */
  remaining: number;
  /** 追加到 system instructions 末尾的预算提示。 */
  notice: string;
  /** 这一步是否禁止调工具、只能作答。 */
  mustAnswer: boolean;
};

export const MUST_ANSWER_NOTICE =
  '【收口】这是最后一步，工具已关闭。不要说明你打算做什么 —— ' +
  '直接用已执行的查询结果回答用户：先给结论和关键数字，再指出数字来自哪次查询；' +
  '证据不足就如实说缺什么、已经查到了什么。';

export function planStep(stepNumber: number, maxSteps: number): StepPlan {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`maxSteps 必须是正整数，收到 ${maxSteps}`);
  }
  const s = Math.max(0, Math.floor(stepNumber));
  const remaining = Math.max(0, maxSteps - s);
  const nth = Math.min(s + 1, maxSteps);
  const budget = `第 ${nth}/${maxSteps} 步`;

  if (remaining <= 1) {
    return { stepNumber: s, remaining, mustAnswer: true, notice: MUST_ANSWER_NOTICE };
  }

  if (remaining === 2) {
    return {
      stepNumber: s,
      remaining,
      mustAnswer: false,
      notice:
        `【步数预算】${budget}，只剩 2 步。下一步必须作答：` +
        '现在就把结论和支撑数字整理好，不要再开新的查询方向。',
    };
  }

  // 过半：不再允许"探索性"查询。这是"答得出"与"查得全"之间刻意选前者。
  if (s >= Math.ceil(maxSteps / 2)) {
    return {
      stepNumber: s,
      remaining,
      mustAnswer: false,
      notice:
        `【步数预算】${budget}，已过半（还剩 ${remaining} 步）。` +
        '不要再开新的查询方向：已有结果能回答就直接作答；确实缺关键数据，也只允许再查一次。',
    };
  }

  return {
    stepNumber: s,
    remaining,
    mustAnswer: false,
    notice: `【步数预算】${budget}，还剩 ${remaining} 步（最后一格只能作答，不能调工具）。`,
  };
}
