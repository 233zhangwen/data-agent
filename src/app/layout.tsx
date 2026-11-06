import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '数据问答 Agent · Text-to-SQL 作品集',
  description:
    '用自然语言问业务数据：Agent 自主选择工具、生成 SQL、执行、出错自己改，并把每一步摊开给你看。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
