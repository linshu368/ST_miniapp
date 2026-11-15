'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bookmark, Check, ChevronRight, Clapperboard, Clock3, Play } from 'lucide-react';
import type { DramaSummary } from '@miniapp/shared';

import { usePrefetchDramaPlayback } from '@/lib/api/drama';
import { dramaTiming, coverLoadMs } from '@/lib/perf/drama-observer';
import { supabasePublicImageSrcSet, supabasePublicImageUrl } from '@/lib/supabase-image';
import { cn } from '@/lib/utils';
import { ReturnFlash } from '@/components/ui/return-flash';
import { useDramaLibraryStore, type DramaProgress } from '@/stores/drama-library-store';

/** 剧场与追剧共用的剧卡、入口与空态；剧卡和「随便看看」进放映，续看与追剧行进详情选集。 */

const STICKY_SEARCH_HEIGHT = 60;

export function DramaLink({
  drama,
  queue,
  feed = false,
  cardId,
  onOpen,
  children,
  className,
  label,
}: {
  drama: DramaSummary;
  queue: DramaSummary[];
  /** true 进放映（上下滑换剧），否则进详情（上下滑切集）。 */
  feed?: boolean;
  /** 剧场网格卡片的锚点，从放映返回时据此找回位置。 */
  cardId?: string;
  onOpen?: () => void;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const prefetch = usePrefetchDramaPlayback();
  return (
    <Link
      href={feed ? '/watch' : `/dramas/${drama.id}`}
      prefetch={false}
      className={className}
      aria-label={label ?? `观看 ${drama.title}`}
      data-drama-cover={feed ? '' : undefined}
      data-drama-card-id={cardId}
      onClick={(event) => {
        onOpen?.();
        const progress = useDramaLibraryStore.getState().history[drama.id];
        const videoId = progress && !progress.completed ? progress.videoId : undefined;
        // 放映按 activeId 定位起始剧，换剧队列由 prefetch 冻结为当前所见列表。
        if (feed) useDramaLibraryStore.getState().setBrowse({ activeId: drama.id });
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        ) {
          const image = event.currentTarget.querySelector('img');
          const cover = !drama.cover_url
            ? { outcome: 'absent' as const }
            : image
              ? image.complete
                ? {
                    outcome: image.naturalWidth > 0 ? ('loaded' as const) : ('error' as const),
                    loadMs: coverLoadMs(image),
                  }
                : { outcome: 'pending' as const }
              : { outcome: 'error' as const };
          dramaTiming.beginPlayback(drama.id, 'cover', videoId, cover, feed ? 'home' : 'detail');
        }
        prefetch(drama.id, queue, videoId);
      }}
    >
      {children}
    </Link>
  );
}

export function Poster({
  drama,
  className,
  sizes = '(max-width: 640px) 50vw, 240px',
  eager = false,
  priority = false,
  onSettled,
}: {
  drama: DramaSummary;
  className?: string;
  sizes?: string;
  eager?: boolean;
  priority?: boolean;
  onSettled?: (outcome: 'loaded' | 'error' | 'absent') => void;
}) {
  const [failed, setFailed] = useState(false);
  const settled = useRef(false);
  const settle = useCallback(
    (outcome: 'loaded' | 'error' | 'absent') => {
      if (settled.current) return;
      settled.current = true;
      onSettled?.(outcome);
    },
    [onSettled]
  );
  useEffect(() => {
    if (!drama.cover_url) settle('absent');
  }, [drama.cover_url, settle]);
  const cover = drama.cover_url
    ? supabasePublicImageUrl(drama.cover_url, { width: 360, height: 480, quality: 68 })
    : undefined;
  const coverSrcSet = drama.cover_url
    ? supabasePublicImageSrcSet(drama.cover_url, [240, 360, 480], { width: 3, height: 4 })
    : undefined;
  return (
    <div className={cn('relative overflow-hidden bg-[#2a272a]', className)}>
      <Clapperboard
        aria-hidden
        className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-[#eee7e2]/15"
      />
      {drama.cover_url && !failed ? (
        <img
          ref={(node) => {
            if (node?.complete && node.naturalWidth > 0) settle('loaded');
          }}
          src={cover}
          srcSet={coverSrcSet}
          sizes={sizes}
          alt=""
          loading={priority || eager ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={priority ? 'high' : eager ? 'auto' : 'low'}
          className="absolute inset-0 h-full w-full object-cover"
          onLoad={() => settle('loaded')}
          onError={() => {
            setFailed(true);
            settle('error');
          }}
        />
      ) : null}
    </div>
  );
}

export function DramaCard({
  drama,
  queue,
  progress,
  onOpen,
  eager,
  priority,
  flash = false,
  onPosterSettled,
}: {
  drama: DramaSummary;
  queue: DramaSummary[];
  progress?: DramaProgress;
  onOpen: () => void;
  eager: boolean;
  priority: boolean;
  /** 从放映返回时标出最后看的那部：金边亮一下后淡出。 */
  flash?: boolean;
  onPosterSettled?: (id: string, outcome: 'loaded' | 'error' | 'absent') => void;
}) {
  return (
    <DramaLink
      drama={drama}
      queue={queue}
      feed
      cardId={drama.id}
      onOpen={onOpen}
      className="relative min-w-0 overflow-hidden rounded-xl bg-[#1f1d20] pb-3 [content-visibility:auto] [contain-intrinsic-size:0_320px] active:opacity-70"
    >
      {flash ? <ReturnFlash /> : null}
      <div className="relative">
        <Poster
          drama={drama}
          eager={eager}
          priority={priority}
          onSettled={onPosterSettled ? (outcome) => onPosterSettled(drama.id, outcome) : undefined}
          className="aspect-[3/4] w-full"
        />
        <div className="absolute inset-x-0 bottom-0 rounded-b-lg bg-gradient-to-t from-black/75 to-transparent px-2 pb-2 pt-6 text-[10px] text-[#eee7e2]/90">
          {progress
            ? progress.completed
              ? '已看完'
              : `看到第 ${progress.episode} 集`
            : drama.episode_count
              ? `${drama.episode_count} 集`
              : '即将开播'}
        </div>
      </div>
      <h2 className="mx-2.5 mt-2.5 line-clamp-2 text-[14px] font-medium leading-[21px]">
        {drama.title}
      </h2>
    </DramaLink>
  );
}

/** 把最后看的剧滚进可视区（扣掉吸顶搜索栏）；已完整可见就不动。返回是否找到卡片。 */
export function revealDramaCard(container: HTMLElement, id: string): boolean {
  const card = container.querySelector(`[data-drama-card-id="${CSS.escape(id)}"]`);
  if (!card) return false;
  const align = () => {
    const box = container.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const top = box.top + STICKY_SEARCH_HEIGHT;
    if (rect.top >= top && rect.bottom <= box.bottom) return;
    container.scrollTop += rect.top - top - (box.bottom - top - rect.height) / 2;
  };
  align();
  // 屏外卡片受 content-visibility 影响按占位高度估算，真正绘制后再校正一次。
  requestAnimationFrame(align);
  return true;
}

const STACK_LAYOUT = [
  'left-0 z-[3]',
  'left-2.5 z-[2] rotate-[3deg] scale-95 opacity-80',
  'left-5 z-[1] rotate-[7deg] scale-90 opacity-[0.55]',
];

/** 剧场顶部的放映入口：按全部精选顺序连播，从上次放映停下的那部开始。 */
export function FeedStrip({ dramas, onOpen }: { dramas: DramaSummary[]; onOpen: () => void }) {
  const activeId = useDramaLibraryStore((state) => state.browse.activeId);
  const playable = dramas.filter((drama) => drama.episode_count > 0);
  const start = Math.max(
    0,
    playable.findIndex((drama) => drama.id === activeId)
  );
  const lead = playable[start];
  if (!lead) return null;
  // 起始剧排在 DOM 第一位，点击计时读取的就是它的封面加载状态。
  const stack = [0, 1, 2].flatMap((offset) => playable[(start + offset) % playable.length] ?? []);
  return (
    <DramaLink
      drama={lead}
      queue={dramas}
      feed
      onOpen={onOpen}
      label="随便看看，从精选开始连播"
      className="mb-1 mt-1 flex w-full items-center gap-3 rounded-2xl bg-[linear-gradient(100deg,rgba(217,184,138,0.13),rgba(217,184,138,0.04)_60%,rgba(255,255,255,0.03))] py-2.5 pl-2.5 pr-3 shadow-[inset_0_0_0_0.5px_rgba(217,184,138,0.25)] active:opacity-80"
    >
      <span aria-hidden className="relative h-[60px] w-16 shrink-0">
        {stack.map((drama, index) => (
          <Poster
            key={`${drama.id}:${index}`}
            drama={drama}
            sizes="44px"
            className={cn(
              'absolute top-0 h-[60px] w-11 rounded-lg shadow-[0_4px_10px_rgba(0,0,0,0.45)]',
              STACK_LAYOUT[index]
            )}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-[#f1dfc3]">随便看看</span>
        <span className="block truncate text-[11.5px] text-[#eee7e2]/50">
          从精选开始连播 · 上下滑换剧
        </span>
      </span>
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#d9b88a] text-[#1b1612]"
      >
        <Play className="h-4 w-4 fill-current" />
      </span>
    </DramaLink>
  );
}

export function ContinueWatching({
  drama,
  progress,
  queue,
  onOpen,
}: {
  drama: DramaSummary;
  progress: DramaProgress;
  queue: DramaSummary[];
  onOpen: () => void;
}) {
  return (
    <DramaLink
      drama={drama}
      queue={queue}
      onOpen={onOpen}
      label={`继续观看 ${drama.title}`}
      className="mb-3 mt-1 flex items-center gap-2 rounded-xl bg-white/5 px-3 py-3"
    >
      <Clock3 className="h-4 w-4 shrink-0 text-[#c4a0a7]" />
      <span className="min-w-0 flex-1 truncate text-xs text-[#eee7e2]/70">
        {progress.completed ? '再看一遍' : '接着看'} · {drama.title}
      </span>
      <span className="shrink-0 text-[11px] text-[#eee7e2]/40">第 {progress.episode} 集</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[#eee7e2]/40" />
    </DramaLink>
  );
}

export function LibraryRow({
  drama,
  progress,
  queue,
  onOpen,
}: {
  drama: DramaSummary;
  progress?: DramaProgress;
  queue: DramaSummary[];
  onOpen: () => void;
}) {
  const saved = useDramaLibraryStore((state) => state.saved.includes(drama.id));
  const toggleSaved = useDramaLibraryStore((state) => state.toggleSaved);
  return (
    <article className="relative" data-library-drama-id={drama.id}>
      <DramaLink
        drama={drama}
        queue={queue}
        onOpen={onOpen}
        label={`${progress?.completed ? '重看' : '继续观看'} ${drama.title}`}
        className="flex min-w-0 gap-3 rounded-xl active:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#c99ea7]/60"
      >
        <Poster drama={drama} className="aspect-[3/4] w-[82px] shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col justify-between py-1">
          <div className="min-w-0 pr-10">
            <h2 className="truncate text-[15px] font-semibold">{drama.title}</h2>
            <p className="mt-1.5 text-xs text-[#eee7e2]/40">共 {drama.episode_count} 集</p>
          </div>
          <div className="flex min-h-11 items-center justify-between gap-1">
            <span className="truncate text-[11px] text-[#eee7e2]/45">
              {progress
                ? progress.completed
                  ? '已看完'
                  : `看到第 ${progress.episode} 集`
                : '还没开始看'}
            </span>
            <span className="flex shrink-0 items-center gap-1 pl-3 text-xs font-semibold text-[#c4a0a7]">
              {progress ? (progress.completed ? '再看一遍' : '继续看') : '开始看'}
              <Play className="h-3 w-3 fill-current" />
            </span>
          </div>
        </div>
      </DramaLink>
      <button
        type="button"
        aria-label={`${saved ? '取消收藏' : '收藏'} ${drama.title}`}
        aria-pressed={saved}
        onClick={() => toggleSaved(drama.id)}
        className="absolute -right-2 -top-1 flex h-11 w-11 items-center justify-center rounded-full active:bg-white/5"
      >
        {saved ? (
          <Check className="h-5 w-5 text-[#c4a0a7]" />
        ) : (
          <Bookmark className="h-5 w-5 text-[#eee7e2]/50" />
        )}
      </button>
    </article>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  onAction,
}: {
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div
      role="status"
      className="mx-auto flex max-w-xs flex-col items-center px-4 py-12 text-center"
    >
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
        <Clapperboard className="h-7 w-7 text-[#eee7e2]/35" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[#eee7e2]/45">{detail}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-6 min-h-11 rounded-full bg-[#c99ea7] px-6 text-sm font-semibold text-[#eee7e2] active:bg-[#ba8b96]"
      >
        {action}
      </button>
    </div>
  );
}
