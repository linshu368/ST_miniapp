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
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-3 backdrop-blur-xl pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">设置</h1>
      </header>

      <section className="relative z-10 flex flex-1 flex-col justify-center px-4 py-8">
        <div className="absolute top-0 left-0 right-0 h-40 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.12),transparent_70%)] pointer-events-none" />

        <Card className="relative overflow-hidden rounded-[28px] border border-border bg-card shadow-none backdrop-blur-md">
          <CardContent className="flex flex-col items-center px-6 py-10 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-3xl border border-border bg-secondary text-muted-foreground">
              <Settings className="h-6 w-6" aria-hidden />
            </span>
            <h2 className="mt-5 text-lg font-black tracking-tight text-foreground">设置暂未开放</h2>
            <p className="mt-2 max-w-[260px] text-sm leading-relaxed text-muted-foreground">
              入口位置已保留，相关功能整理完成后会重新开放。
            </p>
            <Button
              onClick={goBack}
              className="mt-7 rounded-full bg-secondary px-6 text-sm font-bold text-foreground hover:bg-accent"
            >
              返回我的
            </Button>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
