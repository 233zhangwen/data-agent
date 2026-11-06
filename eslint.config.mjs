import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Prisma 生成的 client，不是我们的代码
    'src/generated/**',
  ]),
  {
    rules: {
      // Server Action 的 useActionState 签名里 prevState 经常用不上。
      // 约定用 _ 前缀标记「故意不用」，而不是逐行 disable。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]);

export default eslintConfig;
