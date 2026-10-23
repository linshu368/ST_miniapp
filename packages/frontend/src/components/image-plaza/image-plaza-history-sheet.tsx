'use client';

import { History, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useImagePlazaConversationsQuery } from '@/lib/api/image-plaza';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

interface ImagePlazaHistorySheetProps {
  activeId?: string;
  beforeNavigate?: () => void;
  compact?: boolean;
}

export function ImagePlazaHistorySheet({
  activeId,
  beforeNavigate,
  compact = false,
}: ImagePlazaHistorySheetProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="我的生成"
          className={
            compact
              ? 'flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-xl bg-card px-2 text-[10px] font-semibold ring-1 ring-border'
              : 'inline-flex min-h-10 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-card px-2 text-xs font-bold min-[360px]:gap-1.5 min-[360px]:px-3'
          }
        >
          <History className="size-4" aria-hidden />
          {compact ? '历史' : '我的生成'}
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[80dvh] w-full max-w-3xl flex-col rounded-t-3xl border-border bg-background p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
      >
        <div className="flex items-center justify-between gap-3">
          <SheetTitle className="text-base font-bold">我的生成</SheetTitle>
          <SheetClose
            className="grid size-10 place-items-center rounded-full bg-card"
            aria-label="关闭我的生成"
          >
            <X className="size-4" aria-hidden />
          </SheetClose>
        </div>
        <SheetDescription className="mt-1 text-xs">
          回到已有记录，查看生成状态和图片。
        </SheetDescription>
        {open ? (
          <HistoryList
            activeId={activeId}
            onSelect={(id) => {
              beforeNavigate?.();
              setOpen(false);
              if (id !== activeId) router.push(`/create/studio/${id}`);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function HistoryList({
  activeId,
  onSelect,
}: {
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  const query = useImagePlazaConversationsQuery();
  const records = query.data?.conversations ?? [];

  return (
    <div className="chat-scroll-area mt-4 min-h-0 space-y-2 overflow-y-auto overscroll-contain">
      {query.isLoading ? (
        <p
          role="status"
          className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          正在读取记录…
        </p>
      ) : null}
      {query.isError ? (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <p>生成记录暂时未能同步。</p>
          <button
            type="button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-full bg-card px-3 text-xs font-semibold text-primary disabled:opacity-50"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {query.isFetching ? '正在同步…' : '重新读取'}
          </button>
        </div>
      ) : null}
      {!query.isLoading && !query.isError && records.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          还没有生成记录，先生成一张图片吧。
        </p>
      ) : null}
      {records.map((record) => (
        <button
          key={record.id}
          type="button"
          aria-current={record.id === activeId ? 'page' : undefined}
          onClick={() => onSelect(record.id)}
          className={`block w-full rounded-2xl border p-3 text-left ${
            record.id === activeId ? 'border-primary/35 bg-primary/10' : 'border-border bg-card'
          }`}
        >
          <span className="block truncate text-sm font-semibold">{record.title}</span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {new Date(record.updated_at).toLocaleString('zh-CN')}
            {record.id === activeId ? ' · 当前记录' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}
