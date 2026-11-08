import { AskPanel } from './AskPanel';

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">数据问答 Agent</h1>
        <p className="text-sm text-zinc-500">
          21 张业务表（电商 + SaaS，约 13 万行）。问它问题，它会自己决定看哪张表、写什么
          SQL、错了怎么改 —— 每一步都摊在下面。
        </p>
      </header>

      <AskPanel />

      <footer className="mt-auto border-t pt-4 text-xs text-zinc-400">
        试试：「上个月 GMV 是多少」「哪个品类卖得最好」「买了硬件的客户里有多少订阅了服务」
      </footer>
    </main>
  );
}
