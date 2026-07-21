import Link from 'next/link';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function CreatePage() {
  return (
    <main
      data-app-shell="create"
      className="app-page mx-auto flex w-full max-w-screen-xl flex-col px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]"
    >
      <header>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-primary">Create</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight">创作</h1>
        </div>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <Button
          asChild
          size="lg"
          className="h-14 rounded-full border-0 bg-primary px-10 text-base font-bold text-primary-foreground shadow-lg shadow-primary/20 ring-0 hover:bg-primary/90 focus-visible:ring-0"
        >
          <Link href="/create/wish">
            <Sparkles className="size-5" aria-hidden />
            许愿池
          </Link>
        </Button>
        <div className="app-surface px-6 py-8 backdrop-blur">
          <p className="text-[13px] font-medium text-foreground">创作功能即将上线</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            想要什么角色，可以先进入许愿池告诉我们。
          </p>
        </div>
      </section>
    </main>
  );
}
