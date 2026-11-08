/**
 * `search_schema` 工具的核心：从 21 张表的语义文档里选出和问题最相关的几张。
 *
 * 为什么是关键词 + IDF 而不是向量检索（docs/ACCEPTANCE-W2.md 1.1，已拍板）：
 *   · 语料只有 21 篇，向量的优势（同义改写）发挥不出来；
 *   · 表名列名是专有名词，字符串匹配的 precision 接近 1；
 *   · 纯函数 → 不 mock 就能单测；不依赖 embedding 服务 → 少一个线上故障点。
 *   W3 评测量 recall@3，< 0.85 才换向量（schema_docs.embedding 字段留着）。
 *
 * 返回里带 `matched`（命中了哪些词、各贡献多少分）：模型据此判断选表是否靠谱，
 * 前端据此展示「因为命中『复购』『订阅』所以选了 subscriptions」——可解释的检索。
 */

import type { TableDoc } from './schema-docs';

export type RankedTable = {
  table: string;
  score: number;
  /** 贡献了分数的查询词元，按贡献降序。 */
  matched: string[];
};

/** 中文 2-gram + 英文词元（含 snake_case 拆分）。单个汉字太噪，不成 gram 不收。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const m of text.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
    const word = m[0].toLowerCase();
    tokens.push(word);
    // subscription_seats → subscription / seats：查「seats」也能命中
    if (word.includes('_')) tokens.push(...word.split('_').filter(Boolean));
  }

  for (const m of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seq = m[0];
    if (seq.length === 1) {
      tokens.push(seq);
      continue;
    }
    for (let i = 0; i < seq.length - 1; i++) tokens.push(seq.slice(i, i + 2));
  }

  return tokens;
}

/** 一张表的检索文本 = 表名 + 概述 + 列说明 + 常见错误。pitfall 里的词往往就是问题里的词。 */
function docText(doc: TableDoc): string {
  return `${doc.table} ${doc.summary} ${doc.columns} ${doc.pitfall ?? ''} ${doc.synonyms ?? ''}`;
}

/**
 * IDF：ln(1 + N / (1 + df))。语料内每个词都有的（如「客户」）权重低，
 * 只有两三张表提到的（如「复购」「退货」）权重高——后者才是选表的信号。
 */
function idf(queryTokens: string[], corpusTokens: string[][]): Map<string, number> {
  const n = corpusTokens.length;
  const df = new Map<string, number>();
  const corpusSets = corpusTokens.map((tokens) => new Set(tokens));

  for (const t of new Set(queryTokens)) {
    let d = 0;
    for (const s of corpusSets) if (s.has(t)) d++;
    df.set(t, d);
  }

  const scores = new Map<string, number>();
  for (const [t, d] of df) scores.set(t, Math.log(1 + n / (1 + d)));
  return scores;
}

/**
 * 对问题打分排序。分数非正（一个词都没命中）的表不返回——
 * 返回一个零分表比返回空更误导：模型会以为「检索过了，这几张就是相关的」。
 */
export function rankTables(
  query: string,
  docs: readonly TableDoc[],
  topK = 5,
): RankedTable[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const corpusTokens = docs.map((d) => tokenize(docText(d)));
  const weights = idf(queryTokens, corpusTokens);

  const ranked: RankedTable[] = [];
  for (let i = 0; i < docs.length; i++) {
    // 词频用 sqrt 阻尼：出现 4 次只比 1 次强一倍，避免长文档霸榜
    const tf = new Map<string, number>();
    for (const t of corpusTokens[i]) tf.set(t, (tf.get(t) ?? 0) + 1);

    const contribution = new Map<string, number>();
    let score = 0;
    for (const t of new Set(queryTokens)) {
      const f = tf.get(t);
      const w = weights.get(t);
      if (!f || w === undefined) continue;
      const c = w * Math.sqrt(f);
      contribution.set(t, c);
      score += c;
    }

    // 问题里直接写了表名：这不是语义匹配是精确指向，给足权重
    if (queryTokens.includes(docs[i].table.toLowerCase())) {
      score += 2;
      contribution.set(docs[i].table, (contribution.get(docs[i].table) ?? 0) + 2);
    }

    if (score <= 0) continue;

    const matched = [...contribution.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t]) => t);

    ranked.push({ table: docs[i].table, score: Number(score.toFixed(3)), matched });
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, topK);
}
