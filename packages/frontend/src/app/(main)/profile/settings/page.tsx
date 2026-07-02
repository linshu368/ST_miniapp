'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { useTelegramBackButton } from '@/lib/telegram';

export default function SettingsPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-[#080014] text-white">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-white/5 bg-[#080014]/80 px-3 py-3 backdrop-blur-xl pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-white/60 hover:text-white hover:bg-white/10"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">设置</h1>
      </header>

      <section className="relative z-10 flex flex-1 flex-col justify-center px-4 py-8">
        <div className="absolute top-0 left-0 right-0 h-40 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none" />

        <Card className="relative overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.04] shadow-none backdrop-blur-md">
          <CardContent className="flex flex-col items-center px-6 py-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-3xl border border-white/10 bg-white/5 text-white/50">
              <Settings className="h-6 w-6" aria-hidden />
            </span>
            <h2 className="mt-5 text-lg font-black tracking-tight text-white">设置暂未开放</h2>
            <p className="mt-2 max-w-[260px] text-sm leading-relaxed text-white/45">
              入口位置已保留，相关功能整理完成后会重新开放。
            </p>
            <Button
              onClick={goBack}
              className="mt-7 rounded-full bg-white/10 px-6 text-sm font-bold text-white hover:bg-white/15"
            >
              返回我的
            </Button>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
