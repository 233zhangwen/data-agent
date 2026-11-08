import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 本机构建时 .next 目录会卡在写 trace 上（环境问题，不是代码问题）：
  // `NEXT_BUILD_PROBE=1 npx next build` 换一个产物目录就能完整跑完，用来验证打包。
  ...(process.env.NEXT_BUILD_PROBE ? { distDir: '.build-probe' } : {}),
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
