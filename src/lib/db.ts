import { PrismaPg } from '@prisma/adapter-pg';
/**
 * 用**相对路径**而不是 `@/generated/prisma/client`。
 *
 * 原因：脚本（eval / seed）要 `import { ... } from '../src/lib/xxx.ts'` 直接跑真代码，
 * 而 Node 的 `--experimental-strip-types` **不解析 tsconfig 的 paths**。
 * 这条依赖链上只要有一个 `@/`，整条链就跑不起来，脚本就只能再抄一份逻辑 ——
 * 那正是"评测了半年的假系统"的来源（项目 #1 踩过）。
 */
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma 7 不再内置连接池，必须显式传 driver adapter。
 * 应用连接是**读写**账号 —— 只用来存对话、保存查询、写表结构索引。
 * Agent 查业务数据走另一条只读连接（src/lib/agent-db.ts），两条不能混。
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('缺少环境变量 DATABASE_URL，检查 .env.local 是否配置');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** 挂 globalThis：dev 热更新会反复执行本模块，每次 new 一个池会把 Neon 连接数吃光。 */
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
