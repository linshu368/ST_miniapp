'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Heart, ImageIcon, LoaderCircle, Search, Sparkles, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useCreateImagePlazaConversationMutation,
  useImagePlazaFeedQuery,
} from '@/lib/api/image-plaza';

export default function CreatePage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('all');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const feed = useImagePlazaFeedQuery(debouncedSearch, tag);
  const createConversation = useCreateImagePlazaConversationMutation();
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && feed.hasNextPage && !feed.isFetchingNextPage) {
          void feed.fetchNextPage();
        }
      },
      { rootMargin: '240px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [feed]);

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const tags = feed.data?.pages[0]?.tags ?? [{ id: 'all', label: '全部' }];

  const startStudio = (sourceWorkId?: string) => {
    createConversation.mutate(sourceWorkId ? { source_work_id: sourceWorkId } : {}, {
      onSuccess: ({ conversation }) => router.push(`/create/studio/${conversation.id}`),
    });
  };

  return (
    <main
      data-app-shell="image-plaza"
      className="mx-auto min-h-screen w-full max-w-screen-xl bg-background text-foreground"
    >
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/90 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary/70">
              Discover
            </p>
            <h1 className="text-2xl font-black tracking-tight">图片广场</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => startStudio()}
              disabled={createConversation.isPending}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-4 text-xs font-black text-primary-foreground shadow-[0_8px_30px_hsl(var(--primary)/0.2)] disabled:opacity-60 sm:px-5 sm:text-sm"
            >
              {createConversation.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              去创作
            </button>
          </div>
        </div>
        <label className="mt-4 flex h-11 items-center gap-2 rounded-2xl border border-border bg-card px-3 text-muted-foreground">
          <Search className="size-4" aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索作品灵感"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="搜索图片广场"
          />
        </label>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          {tags.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTag(item.id)}
              className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold transition ${tag === item.id ? 'bg-foreground text-background' : 'bg-card text-muted-foreground ring-1 ring-border'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <section className="px-3 py-4">
        {feed.isLoading ? (
          <div className="flex min-h-[45vh] items-center justify-center text-muted-foreground">
            <LoaderCircle className="size-6 animate-spin" />
          </div>
        ) : feed.isError ? (
          <EmptyState
            icon={<ImageIcon />}
            title="广场暂时走丢了"
            action="重新加载"
            onAction={() => void feed.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<WandSparkles />}
            title={search || tag !== 'all' ? '没有找到对应作品' : '还没有公开作品'}
            action={search || tag !== 'all' ? '查看全部' : '创作第一张'}
            onAction={() => {
              if (search || tag !== 'all') {
                setSearch('');
                setTag('all');
              } else startStudio();
            }}
          />
        ) : (
          <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
            {items.map((work) => (
              <article
                key={work.id}
                className="group relative mb-3 break-inside-avoid overflow-hidden rounded-[1.35rem] bg-card ring-1 ring-border/70"
              >
                <Link
                  href={`/create/work/${work.id}`}
                  aria-label={`查看作品：${work.title}`}
                  className="block"
                >
                  <img
                    src={work.image_url}
                    alt={work.title}
                    loading="lazy"
                    className="h-auto w-full object-cover transition duration-500 group-hover:scale-[1.02]"
                  />
                </Link>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-3 pt-12 text-white">
                  <span className="min-w-0 truncate text-xs font-bold">{work.title}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px]">
                    <Heart className={`size-3.5 ${work.liked ? 'fill-current' : ''}`} />
                    {work.like_count}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => startStudio(work.id)}
                  aria-label={`用同款：${work.title}`}
                  className="absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-black/45 text-white backdrop-blur-md transition active:scale-95"
                >
                  <WandSparkles className="size-4" />
                </button>
              </article>
            ))}
          </div>
        )}
        <div
          ref={sentinel}
          className="flex h-16 items-center justify-center text-xs text-muted-foreground"
        >
          {feed.isFetchingNextPage ? (
            <LoaderCircle className="size-5 animate-spin" />
          ) : !feed.hasNextPage && items.length > 0 ? (
            '已经到底啦'
          ) : null}
        </div>
      </section>
      {createConversation.isError ? (
        <p className="fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full bg-destructive px-4 py-2 text-xs font-bold text-destructive-foreground">
          创建会话失败，请重试
        </p>
      ) : null}
    </main>
  );
}

function EmptyState(props: {
  icon: React.ReactNode;
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-[48vh] flex-col items-center justify-center gap-4 text-center text-muted-foreground">
      <div className="grid size-14 place-items-center rounded-full bg-card text-primary ring-1 ring-border">
        {props.icon}
      </div>
      <p className="text-sm font-bold text-foreground">{props.title}</p>
      <button
        type="button"
        onClick={props.onAction}
        className="rounded-full bg-primary px-5 py-2.5 text-xs font-black text-primary-foreground"
      >
        {props.action}
      </button>
    </div>
  );
}
