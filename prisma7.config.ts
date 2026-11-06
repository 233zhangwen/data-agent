// Prisma 7 配置文件（旧版里 schema.prisma 的 url 搬到了这里）
//
// 只服务 Prisma CLI（migrate / studio / generate），不参与应用运行时。
// 用 DIRECT_URL 而不是 DATABASE_URL：迁移要改表结构，直连更稳，
// 不会被 pooler 的连接复用干扰。应用运行时的地址在 src/lib/db.ts 里单独读。

import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: '.env.local', override: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DIRECT_URL'] ?? '',
  },
});
