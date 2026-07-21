import Link from 'next/link';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function CreatePage() {
  return (
    <main
      data-app-shell="create"
      className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col bg-[#0A0A0A] px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] text-white"
    >
      <header>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-purple-300/70">Create</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight">创作</h1>
        </div>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <Button
          asChild
          size="lg"
          className="h-14 rounded-full border-0 bg-white px-10 text-base font-bold text-slate-950 shadow-none ring-0 hover:bg-purple-100 focus-visible:ring-0"
        >
          <Link href="/create/wish">
            <Sparkles className="size-5" aria-hidden />
            许愿池
          </Link>
        </Button>
        <div className="rounded-3xl border border-white/10 bg-white/[0.04] px-6 py-8 shadow-2xl shadow-black/30 backdrop-blur">
          <p className="text-[13px] font-medium text-slate-300">创作功能即将上线</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            想要什么角色，可以先进入许愿池告诉我们。
          </p>
        </div>
      </section>
    </main>
  );
}
