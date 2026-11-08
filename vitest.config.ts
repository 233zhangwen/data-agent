import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 源码里用 @/ 别名（Next 约定），vitest 要显式告诉它怎么解析
  resolve: { alias: { '@': path.join(root, 'src') } },
  test: {
    include: ['tests/**/*.test.ts', 'eval/**/*.eval.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // DB 测试打到 Neon（新加坡），给足网络往返时间
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
