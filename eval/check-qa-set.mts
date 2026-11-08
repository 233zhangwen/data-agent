/**
 * 评测集的参考值校准：把 `qa-set.json` 里的每条参考 SQL 跑一遍，得到真值。
 *
 * 存在的意义（W3 C17 的方法论要求）：
 *   参考值**必须由 SQL 算出来**，不能由人工填、更不能由模型给。
 *   人工填会记错（数字一多必然错），模型给就是自证。
 *
 * 用法：
 *   node --experimental-transform-types eval/check-qa-set.mts          # 只校验，不改文件
 *   node --experimental-transform-types eval/check-qa-set.mts --write  # 把算出的值写回 JSON
 *
 * 若库里数据被重灌（seed 重跑），参考值会变，脚本会报出不一致的条目——
 * 这是设计意图：评测集的数字与数据版本绑定，别让它悄悄漂移。
 */

import pg from 'pg';
import fs from 'fs';

type Alt = { sql: string[]; note: string; value?: number | null };
/** 一个可接受口径：自带参考 SQL，值由 SQL 算出（不由人工填）。 */
type Interp = { label: string; keywords?: string[]; sql: string[]; value?: number | null };
type Case = {
  id: string;
  cls: 'A' | 'B' | 'C' | 'D';
  mode: 'value' | 'series' | 'caveat' | 'refuse' | 'qualitative' | 'interpretations';
  question: string;
  sql?: string[];
  alts?: Alt[];
  interpretations?: Interp[];
  value?: number | null;
  values?: number[] | null;
  tolerance?: number;
  unit?: string;
  caveatKeywords?: string[];
  note?: string;
};

const WRITE = process.argv.includes('--write');
const FILE = 'eval/qa-set.json';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);

const set = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { meta: unknown; cases: Case[] };
const client = new pg.Client({ connectionString: env.AGENT_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

let drift = 0;
let missing = 0;
let filled = 0;

for (const c of set.cases) {
  if (c.mode === 'refuse' || c.mode === 'qualitative') {
    console.log(`—  ${c.id} ${c.cls} ${c.mode.padEnd(15)} 跳过（判的是行为，不是数字）`);
    continue;
  }

  // D 类口径题：每个可接受口径一条参考 SQL，逐个算真值。
  // 不做这一步的后果 W3 已经验过：同一题四次跑给四个数、四个都对，全被单一数字判据判成错。
  if (c.mode === 'interpretations') {
    const interps = c.interpretations ?? [];
    if (interps.length === 0) {
      console.error(`✗ ${c.id} interpretations 模式但没配口径`);
      process.exitCode = 1;
      continue;
    }
    const got: string[] = [];
    for (const it of interps) {
      try {
        const r = await client.query(it.sql.join('\n'));
        const v = r.rows.length ? Number(Object.values(r.rows[0])[0]) : null;
        const prev = it.value ?? null;
        const same =
          prev !== null && v !== null && Math.abs(prev - v) <= Math.abs(prev) * 0.0001 + 0.01;
        if (prev === null || prev === undefined) {
          missing++;
        } else if (!same) {
          drift++;
        }
        if (WRITE) it.value = v;
        got.push(`${it.label}=${v}${same ? '' : prev === null ? '（新）' : '（漂移）'}`);
      } catch (e) {
        console.error(`✗ ${c.id} 口径「${it.label}」的 SQL 跑不通：${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
    console.log(`✓ ${c.id} ${c.cls} interpretations ${interps.length} 个口径`);
    for (const g of got) console.log(`     ${g}`);
    continue;
  }

  let computed: number | number[] | null = null;
  const mainSql = c.sql?.join('\n') ?? '';
  try {
    if (c.mode === 'series') {
      const r = await client.query(mainSql);
      computed = r.rows.map((row) => Number(Object.values(row)[Object.keys(row).length - 1]));
    } else {
      const r = await client.query(mainSql);
      computed = r.rows.length ? Number(Object.values(r.rows[0])[0]) : null;
    }
  } catch (e) {
    console.error(`✗ ${c.id} 参考 SQL 本身跑不通：${(e as Error).message}`);
    console.error(`   ${mainSql}`);
    process.exitCode = 1;
    continue;
  }

  // 备选口径（同一题的其他正确答案）
  const altValues: number[] = [];
  for (const alt of c.alts ?? []) {
    try {
      const r = await client.query(alt.sql.join('\n'));
      const v = r.rows.length ? Number(Object.values(r.rows[0])[0]) : null;
      alt.value = v;
      if (v !== null) altValues.push(v);
    } catch (e) {
      console.error(`✗ ${c.id} 备选 SQL 跑不通：${(e as Error).message}`);
      process.exitCode = 1;
    }
  }

  const fmt = (v: number | number[] | null) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));

  if (c.mode === 'series') {
    const prev = c.values ?? null;
    const same = prev && computed && prev.length === (computed as number[]).length
      && prev.every((v, i) => v === (computed as number[])[i]);
    if (prev === null || prev === undefined) {
      missing++;
      console.log(`＋ ${c.id} ${c.cls} ${c.mode.padEnd(6)} 新增值 ${fmt(computed)}`);
    } else if (!same) {
      drift++;
      console.log(`⚠ ${c.id} ${c.cls} 值漂移：JSON ${fmt(prev)} → 实际 ${fmt(computed)}`);
    } else {
      console.log(`✓ ${c.id} ${c.cls} ${c.mode.padEnd(6)} ${fmt(computed)}`);
    }
    if (WRITE) c.values = computed as number[];
  } else {
    const prev = c.value ?? null;
    const same = prev !== null && computed !== null && Math.abs(prev - (computed as number)) <= Math.abs(prev) * 0.0001 + 0.01;
    if (prev === null || prev === undefined) {
      missing++;
      console.log(`＋ ${c.id} ${c.cls} ${c.mode.padEnd(6)} 新增值 ${fmt(computed)}${c.unit ? ' ' + c.unit : ''}${altValues.length ? ` (备选 ${fmt(altValues)})` : ''}`);
    } else if (!same) {
      drift++;
      console.log(`⚠ ${c.id} ${c.cls} 值漂移：JSON ${fmt(prev)} → 实际 ${fmt(computed)}`);
    } else {
      console.log(`✓ ${c.id} ${c.cls} ${c.mode.padEnd(6)} ${fmt(computed)}${c.unit ? ' ' + c.unit : ''}`);
    }
    if (WRITE) c.value = computed as number;
  }

  // 数值合法性：空值、0、极大值都可能说明 SQL 写错了
  const val = Array.isArray(computed) ? computed[0] : computed;
  if (val === null || Number.isNaN(val)) {
    console.log(`   ⚠ 参考值是空/NaN —— 检查 SQL 是否查不到数据`);
    filled++;
  }
}

await client.end();

console.log('\n' + '─'.repeat(60));
console.log(`条目 ${set.cases.length} | 缺失 ${missing} | 漂移 ${drift} | 可疑 ${filled}`);

if (WRITE) {
  fs.writeFileSync(FILE, JSON.stringify(set, null, 2) + '\n', 'utf8');
  console.log(`已写回 ${FILE}`);
} else if (missing || drift) {
  console.log('（加 --write 可把算出的值写回 JSON）');
}
