import Link from 'next/link';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function CreatePage() {
  return (
    <main
      data-app-shell="create"
      className="mx-auto flex min-h-screen max-w-md flex-col bg-[#0A0A0A] px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] text-white"
    >
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-purple-300/70">Create</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight">创作</h1>
        </div>
        <Button
          asChild
          size="sm"
          className="rounded-full bg-white text-slate-950 shadow-lg shadow-purple-500/20 hover:bg-purple-100"
        >
          <Link href="/create/wish">
            <Sparkles className="h-4 w-4" aria-hidden />✨ 我想要的角色
          </Link>
        </Button>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center text-center">
        <div className="rounded-3xl border border-white/10 bg-white/[0.04] px-6 py-8 shadow-2xl shadow-black/30 backdrop-blur">
          <p className="text-[13px] font-medium text-slate-300">创作功能即将上线</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            没找到想聊的类型？告诉我们你想要什么样的角色。
          </p>
        </div>
      </section>
    </main>
  );
}
