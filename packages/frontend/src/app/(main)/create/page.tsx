'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Copy,
  Heart,
  ImageIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  imagePlazaKeys,
  useCreateImagePlazaConversationMutation,
  useImagePlazaFeedQuery,
  useSetImagePlazaLikeMutation,
} from '@/lib/api/image-plaza';
import type { ImagePlazaWork } from '@miniapp/shared';

export default function CreatePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('all');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const feed = useImagePlazaFeedQuery(debouncedSearch, tag);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = feed;
  const createConversation = useCreateImagePlazaConversationMutation();
  const sentinel = useRef<HTMLDivElement | null>(null);
  const pullStartY = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [pendingSourceWorkId, setPendingSourceWorkId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '240px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const tags = feed.data?.pages[0]?.tags ?? [{ id: 'all', label: '全部' }];

  const startStudio = (sourceWorkId?: string) => {
    setPendingSourceWorkId(sourceWorkId ?? 'new');
    createConversation.mutate(sourceWorkId ? { source_work_id: sourceWorkId } : {}, {
      onSuccess: ({ conversation }) => router.push(`/create/studio/${conversation.id}`),
      onError: () => setPendingSourceWorkId(null),
    });
  };

  const refreshFeed = async () => {
    if (isPullRefreshing || feed.isFetchingNextPage) return;
    setIsPullRefreshing(true);
    try {
      await queryClient.resetQueries({
        queryKey: imagePlazaKeys.feed(debouncedSearch, tag),
        exact: true,
      });
    } finally {
      setPullDistance(0);
      setIsPullRefreshing(false);
    }
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    pullStartY.current = window.scrollY <= 0 ? (event.touches[0]?.clientY ?? null) : null;
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    if (pullStartY.current === null) return;
    const delta = (event.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current;
    setPullDistance(delta > 0 ? Math.min(96, delta * 0.45) : 0);
  };

  const handleTouchEnd = () => {
    pullStartY.current = null;
    if (pullDistance >= 64) void refreshFeed();
    else setPullDistance(0);
  };

  return (
    <main
      data-app-shell="image-plaza"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="mx-auto min-h-screen w-full max-w-screen-xl overscroll-y-contain bg-background text-foreground"
    >
      {pullDistance > 0 || isPullRefreshing ? (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-2 text-[11px] font-bold shadow-xl backdrop-blur-xl transition-transform"
          style={{ transform: `translate(-50%, ${isPullRefreshing ? 0 : pullDistance / 3}px)` }}
        >
          <RefreshCw className={`size-3.5 ${isPullRefreshing ? 'animate-spin' : ''}`} />
          {isPullRefreshing ? '正在刷新' : pullDistance >= 64 ? '松开刷新' : '下拉刷新'}
        </div>
      ) : null}
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
            {items.map((work, index) => (
              <PlazaCard
                key={work.id}
                work={work}
                priority={index < 4}
                useSamePending={pendingSourceWorkId === work.id}
                interactionDisabled={createConversation.isPending}
                onPrefetch={() => router.prefetch(`/create/work/${work.id}`)}
                onUseSame={() => startStudio(work.id)}
              />
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

function PlazaCard(props: {
  work: ImagePlazaWork;
  priority: boolean;
  useSamePending: boolean;
  interactionDisabled: boolean;
  onPrefetch: () => void;
  onUseSame: () => void;
}) {
  const like = useSetImagePlazaLikeMutation(props.work.id);
  return (
    <article className="group relative mb-3 break-inside-avoid overflow-hidden rounded-[1.5rem] bg-card ring-1 ring-border/70">
      <Link
        href={`/create/work/${props.work.id}`}
        aria-label={`查看作品：${props.work.title}`}
        onPointerEnter={props.onPrefetch}
        onFocus={props.onPrefetch}
        onTouchStart={props.onPrefetch}
        className="block"
      >
        <img
          src={props.work.image_url}
          alt={props.work.title}
          width={props.work.width}
          height={props.work.height}
          loading={props.priority ? 'eager' : 'lazy'}
          fetchPriority={props.priority ? 'high' : 'auto'}
          decoding="async"
          className="h-auto w-full object-cover transition duration-500 group-hover:scale-[1.02]"
        />
      </Link>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/90 via-black/35 to-transparent p-2 pt-16 text-white sm:p-3 sm:pt-16">
        <button
          type="button"
          disabled={like.isPending}
          onClick={() => like.mutate(!props.work.liked)}
          aria-label={
            props.work.liked ? `取消点赞：${props.work.title}` : `点赞：${props.work.title}`
          }
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full text-xs font-black drop-shadow-md disabled:opacity-60"
        >
          <Heart className={`size-4 ${props.work.liked ? 'fill-current' : ''}`} />
          {props.work.like_count}
        </button>
        <button
          type="button"
          disabled={props.interactionDisabled}
          onClick={props.onUseSame}
          aria-label={`用同款：${props.work.title}`}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-black/45 px-2 text-[11px] font-black text-[#d8c1aa] shadow-lg backdrop-blur-md transition active:scale-95 sm:h-11 sm:gap-1.5 sm:px-3 sm:text-xs"
        >
          {props.useSamePending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Copy className="size-4" />
          )}
          {props.useSamePending ? '正在打开' : '用同款'}
        </button>
      </div>
    </article>
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
