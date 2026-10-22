'use client';

import Link from 'next/link';
import { Clapperboard, RefreshCw } from 'lucide-react';
import type { DramaSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { characterRoomGradient } from '@/lib/utils/character-hue';
import { useDramaListQuery, usePrefetchDramaPlayback } from '@/lib/api/drama';

const TAG_DISPLAY_LIMIT = 3;

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** 徽标规则：单集且有时长显示时长，多集显示集数，其余不显示。 */
function dramaBadge(drama: DramaSummary): { position: 'left' | 'right'; text: string } | null {
  if (drama.episode_count === 1 && drama.duration_seconds !== null) {
    return { position: 'right', text: formatDuration(drama.duration_seconds) };
  }
  if (drama.episode_count > 1) {
    return { position: 'left', text: `${drama.episode_count}集` };
  }
  return null;
}

export default function DramasPage() {
  const { data, isLoading, isError, refetch } = useDramaListQuery();
  const dramas = data ?? [];

  return (
    <main className="mx-auto min-h-dvh w-full max-w-screen-xl px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))] text-foreground">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Dramas</p>
        <h1 className="mt-1 text-2xl font-bold">短剧</h1>
        <p className="mt-1 text-sm text-muted-foreground">刷到喜欢的短剧，点开就能看。</p>
      </header>

      {isLoading ? <DramaGridSkeleton /> : null}

      {isError ? <DramaListError onRetry={() => void refetch()} /> : null}

      {!isLoading && !isError && dramas.length === 0 ? <DramaListEmpty /> : null}

      {!isLoading && !isError && dramas.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {dramas.map((drama) => (
            <DramaCard key={drama.id} drama={drama} />
          ))}
        </div>
      ) : null}
    </main>
  );
}

function DramaCard({ drama }: { drama: DramaSummary }) {
  const prefetchPlayback = usePrefetchDramaPlayback();
  const gradient = characterRoomGradient(drama.id);
  const badge = dramaBadge(drama);
  const tags = drama.tags.slice(0, TAG_DISPLAY_LIMIT);

  return (
    <Link
      href={`/dramas/${drama.id}`}
      onClick={() => prefetchPlayback(drama.id)}
      className="group flex flex-col overflow-hidden rounded-[16px] border border-border bg-card text-left shadow-lg transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-2xl active:scale-95"
      aria-label={`查看 ${drama.title}`}
    >
      <div
        className="relative aspect-[3/4] w-full shrink-0 overflow-hidden"
        style={{ background: gradient }}
      >
        {badge ? (
          <span
            className={cn(
              'absolute top-2 z-10 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm',
              badge.position === 'left' ? 'left-2' : 'right-2'
            )}
          >
            {badge.text}
          </span>
        ) : null}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent p-3 pt-8">
          <p className="line-clamp-2 text-sm font-semibold text-white">{drama.title}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 p-2.5">
        {tags.length > 0 ? (
          tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {tag}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-muted-foreground">标签生成中</span>
        )}
      </div>
    </Link>
  );
}

function DramaGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="加载中">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="aspect-[3/4] w-full animate-pulse rounded-[16px] border border-border bg-card"
        />
      ))}
    </div>
  );
}

function DramaListError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
      <p className="text-sm text-destructive">短剧加载失败，请稍后重试。</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        <RefreshCw className="h-4 w-4" />
        重试
      </button>
    </div>
  );
}

function DramaListEmpty() {
  return (
    <div className="rounded-3xl border border-border bg-card p-8 text-center">
      <Clapperboard className="mx-auto h-9 w-9 text-primary" />
      <h2 className="mt-3 font-semibold">短剧正在上架中</h2>
      <p className="mt-1 text-sm text-muted-foreground">很快就能刷到新内容，先去逛逛别的吧。</p>
    </div>
  );
}
