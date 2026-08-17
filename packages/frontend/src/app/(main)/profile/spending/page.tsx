'use client';

import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Loader2, ReceiptText, RefreshCw, Sparkles } from 'lucide-react';
import type { WalletSpendingRecord } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { useWalletSpendingQuery } from '@/lib/api/payment';
import { useTelegramBackButton } from '@/lib/telegram';

export default function SpendingPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const query = useWalletSpendingQuery();
  const items = useMemo(
    () =>
      [...(query.data?.items ?? [])].sort(
        (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
      ),
    [query.data?.items]
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <div>
          <h1 className="text-base font-bold tracking-wide">消耗明细</h1>
          <p className="text-[10px] text-muted-foreground">最近 100 条模型调用</p>
        </div>
      </header>

      <section className="flex flex-1 flex-col gap-3 px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {query.isLoading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            加载中
          </div>
        ) : query.isError && items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
            <RefreshCw className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="text-[13px] font-medium text-muted-foreground">消耗明细暂时无法加载</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              className="rounded-full border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              重新加载
            </Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          items.map((item) => <SpendingRow key={item.id} item={item} />)
        )}
      </section>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
      <div className="mb-2 rounded-full bg-card p-4">
        <ReceiptText className="h-8 w-8 opacity-50" aria-hidden />
      </div>
      <p className="text-[13px] font-medium tracking-wide">暂无星尘消耗记录</p>
    </div>
  );
}

function SpendingRow({ item }: { item: WalletSpendingRecord }) {
  return (
    <article className="flex items-center gap-4 rounded-[20px] border border-border bg-card p-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-bold tracking-tight text-foreground">
          {item.model_display_name}
        </h2>
        <p
          className={
            item.status === 'failed'
              ? 'mt-1 text-[10px] font-semibold text-destructive'
              : item.status === 'pending'
                ? 'mt-1 text-[10px] font-semibold text-warn'
                : 'mt-1 text-[10px] font-semibold text-muted-foreground'
          }
        >
          {item.status_label}
        </p>
        <time
          dateTime={item.created_at}
          className="mt-1 block text-[10px] font-medium tabular-nums tracking-wide text-muted-foreground/70"
        >
          {formatExactDateTime(item.created_at)}
        </time>
      </div>
      <div className="shrink-0 text-right">
        {item.status === 'pending' ? (
          <p className="text-[13px] font-bold text-warn">待结算</p>
        ) : (
          <>
            <p className="text-[15px] font-black tabular-nums text-primary">
              {item.charged_amount > 0 ? '-' : ''}
              {item.charged_amount.toFixed(1)}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">星尘</p>
          </>
        )}
      </div>
    </article>
  );
}

function formatExactDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
