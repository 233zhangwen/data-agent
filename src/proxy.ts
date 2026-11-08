/**
 * 访问控制：口令门（Edge 中间件）。
 *
 * Next 16 起这个文件名是 `proxy.ts`（`middleware.ts` 仍能用但会告警）。它跑在 Edge
 * 运行时，**不能 import Prisma / pg** —— 这条限制在项目 #1 上踩过一次（database
 * session 策略读库，导致所有已登录用户被弹回登录页），所以这里只用 WebCrypto + 环境变量。
 *
 * 三层判断（顺序重要）：
 *   1. 没配 DEMO_PASSCODE：开发放行 / 生产 503。**不放行** —— 安全配置缺失要响，
 *      不能静默降级成"谁都能进"。
 *   2. cookie 里的哈希对得上：放行。
 *   3. 其余：API 返 401 JSON（前端要能读到错误），页面重定向到 /unlock?next=...
 *
 * 为什么不只拦 `/api/ask`：页面本身不烧 token，但让人看到界面再发现问不了，
 * 比直接给一张口令页更糟；而且拦页面顺带挡住爬虫索引。
 */

import { NextResponse, type NextRequest } from 'next/server';

import { isValidPasscodeCookie, PASSCODE_COOKIE } from './lib/passcode';

export default async function proxy(req: NextRequest) {
  const expected = process.env.DEMO_PASSCODE;

  if (!expected) {
    if (process.env.NODE_ENV !== 'production') return NextResponse.next();
    return new NextResponse(
      '服务未配置访问口令（DEMO_PASSCODE），按 fail-closed 策略拒绝所有访问。',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const cookie = req.cookies.get(PASSCODE_COOKIE)?.value;
  if (await isValidPasscodeCookie(cookie, expected)) return NextResponse.next();

  const { pathname, search } = req.nextUrl;

  // /unlock 自身必须放行，否则中间件会把口令页也重定向到口令页（无限循环）
  if (pathname === '/unlock') return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    // 前端 useChat 读 JSON 报错；返回 HTML 会让它显示成"网络错误"
    return NextResponse.json({ error: '需要访问口令（在 /unlock 输入）' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/unlock';
  url.search = '';
  if (pathname !== '/') url.searchParams.set('next', pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * 排除静态资源。别写 `/(.*)`：那会把 _next/static 也拦进来，
   * 口令页自己的 CSS/JS 都加载不出来，表现成"页面是白板"。
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
