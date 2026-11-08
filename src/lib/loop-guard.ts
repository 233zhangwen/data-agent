/**
 * 三级死循环防护（W2 spec 第 2 节）。纯逻辑，不碰数据库，可单测。
 *
 *   L1 完全重复 —— 同一条 SQL（归一化后）第二次出现 → 不执行，直接告知。
 *   L2 同错重复 —— 同一条错误撞到第 3 次 → 给诊断指令（换方向，不是别再试）。
 *   L3 无进展   —— 连续 3 次工具输出指纹相同 → 追加停止指令。
 *
 * 为什么 L2 的动作是「诊断指令」而不是「拒绝执行」：
 *   模型报错后改 SQL 的方向通常是猜（改拼写、换 JOIN 顺序）。同一个错误出现
 *   3 次，说明猜错了维度——它需要的是重新看结构（describeTable），不是第 4 版。
 *   把错误信息转成下一步该做什么，这是"自修"从碰运气变成有策略的分界线。
 *
 * 状态按问答轮次独立（createDataAgent 每请求 new 一次），绝不跨轮复用。
 */

/** SQL 归一化：只留语义（空白折叠 + 小写）。换行排版不同不算改写。 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** djb2 —— 输出指纹只用于"是否相同"的判断，不需要密码学强度。 */
export function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export const L2_SAME_ERROR_AT = 3;
export const L3_STAGNANT_AT = 3;

export function createLoopGuard() {
  const sqlSeen = new Map<string, number>();
  const errSeen = new Map<string, number>();
  let recent: string[] = [];

  return {
    /** L1：这条 SQL 本轮是否已经执行过。 */
    seenSql(sql: string): boolean {
      return (sqlSeen.get(normalizeSql(sql)) ?? 0) >= 1;
    },

    markSqlSeen(sql: string): void {
      const norm = normalizeSql(sql);
      sqlSeen.set(norm, (sqlSeen.get(norm) ?? 0) + 1);
    },

    /**
     * L2：记录一次数据库错误，返回这是第几次。调用方据此决定要不要附诊断指令。
     * `code + message` 归一——position 不参与（它随 SQL 长度漂移，不是错误本质）。
     */
    recordError(code: string | undefined, message: string): number {
      const key = `${code ?? '-'}|${message}`;
      const times = (errSeen.get(key) ?? 0) + 1;
      errSeen.set(key, times);
      return times;
    },

    /** 换了新查询（成功）后，旧错误的计数清零——不同问题不该共享"错误历史"。 */
    clearErrors(): void {
      errSeen.clear();
    },

    /**
     * L3：登记一次工具输出，若恰好连续 N 次相同则返回警告文案（否则 null）。
     * `name` 参与指纹：查同一张表两次不算，同名工具连续返回一样才算绕圈。
     */
    track(name: string, output: string): string | null {
      recent.push(fingerprint(`${name}|${output}`));
      if (recent.length > L3_STAGNANT_AT) recent = recent.slice(-L3_STAGNANT_AT);
      if (recent.length === L3_STAGNANT_AT && new Set(recent).size === 1) {
        return L3_NOTICE;
      }
      return null;
    },
  };
}

export const L3_NOTICE =
  '\n\n⛔ 系统检测：你最近几次工具调用返回了完全相同的结果。' +
  '重复相同的操作不会有新信息。请基于已有数据作答；如果确实缺少关键数据，如实说明缺什么。';

export function l2Notice(times: number): string {
  return (
    `⚠️ 同一个错误你已经撞上 ${times} 次。问题不在 SQL 的写法，在于你对表结构的理解有误。` +
    '请改用 describeTable 重新确认真实列名和类型，或者换一个完全不同的查询思路。'
  );
}

export function l1Notice(hasLastResult: boolean): string {
  return (
    '这条 SQL 你在本轮已经执行过（完全相同，只是写法不同）。结果不会变。' +
    (hasLastResult ? '上一条成功查询的结果还在，可以直接基于它作答或画图。' : '') +
    '要么换一个真正不同的思路，要么停止重试。'
  );
}
