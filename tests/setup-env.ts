/**
 * vitest 全局 setup：把 .env.local 注入 process.env。
 *
 * 为什么不用 dotenv 包：零依赖原则（项目里没有 dotenv，也不为测试引一个）。
 * 为什么必须在 setupFiles 里做：db.ts 在 import 时就创建连接（读 process.env），
 * ESM 的 import 会提升到测试文件顶部之后才执行——setup 先跑，env 才来得及就位。
 */

import fs from 'fs';

const raw = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of raw.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  const value = m[2].trim().replace(/^"(.*)"$/, '$1');
  if (process.env[m[1]] === undefined) process.env[m[1]] = value;
}
