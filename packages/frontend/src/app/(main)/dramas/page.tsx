'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Clapperboard, RefreshCw } from 'lucide-react';
import type { DramaSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { characterRoomGradient } from '@/lib/utils/character-hue';
import { useDramaListQuery, usePrefetchDramaPlayback } from '@/lib/api/drama';
import { selectDramas } from '@/lib/drama-catalog';
import { Input } from '@/components/ui/input';
import { dramaTiming, coverLoadMs } from '@/lib/perf/drama-observer';
import type { DramaTimingReport } from '@/lib/perf/drama-timing';

const TAG_DISPLAY_LIMIT = 3;

const DRAMA_SORT_TABS = [
  { value: 'recommended', label: '推荐' },
  { value: 'latest', label: '最新' },
] as const;

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
  useEffect(() => {
    if (data) dramaTiming.listReady(data);
    else if (isError) dramaTiming.listFailed();
  }, [data, isError]);
  const retryList = () => {
    dramaTiming.beginList('retry');
    void refetch();
  };
  const [activeSort, setActiveSort] =
    useState<(typeof DRAMA_SORT_TABS)[number]['value']>('recommended');
  const [keyword, setKeyword] = useState('');
  const visibleDramas = selectDramas(dramas, keyword, '全部', activeSort);

  return (
    <main className="mx-auto min-h-dvh w-full max-w-screen-xl px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))] text-foreground">
      <header className="mb-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Dramas</p>
        <h1 className="mt-1 text-2xl font-bold">短剧</h1>
      </header>

      <div role="search" aria-label="搜索短剧" className="mb-3">
        <Input
          type="search"
          aria-label="搜索标题、标签或简介"
          placeholder="搜索标题、标签或简介"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>

      <div role="tablist" aria-label="短剧排序" className="mb-4 flex items-center gap-2">
        {DRAMA_SORT_TABS.map((tab) => {
          const active = activeSort === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveSort(tab.value)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-[13px] transition-all',
                active
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground'
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {isLoading ? <DramaGridSkeleton /> : null}

      {isError ? <DramaListError onRetry={retryList} /> : null}

      {!isLoading && !isError && dramas.length === 0 ? <DramaListEmpty /> : null}

      {!isLoading && !isError && dramas.length > 0 && visibleDramas.length === 0 ? (
        <div role="status" className="rounded-3xl border border-border bg-card p-8 text-center">
          <p className="font-semibold">没有找到匹配的短剧</p>
          <button
            type="button"
            className="mt-3 rounded-full px-4 py-2 text-sm text-primary"
            onClick={() => setKeyword('')}
          >
            清除筛选
          </button>
        </div>
      ) : null}

      {!isLoading && !isError && visibleDramas.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visibleDramas.map((drama) => (
            <DramaCard key={drama.id} drama={drama} browseQueue={visibleDramas} />
          ))}
        </div>
      ) : null}
    </main>
  );
}

function DramaCard({ drama, browseQueue }: { drama: DramaSummary; browseQueue: DramaSummary[] }) {
  const prefetchPlayback = usePrefetchDramaPlayback();
  const gradient = characterRoomGradient(drama.id);
  const badge = dramaBadge(drama);
  const tags = drama.tags.slice(0, TAG_DISPLAY_LIMIT);
  // 封面加载失败就退回渐变占位，不影响卡片可用性
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = drama.cover_url !== null && !coverFailed;
  const coverTiming = useRef<DramaTimingReport['cover']>({
    outcome: drama.cover_url ? 'pending' : 'absent',
  });

  return (
    <Link
      href={`/dramas/${drama.id}`}
      onClick={(event) => {
        // 新标签页有自己的时钟与观测，不能在当前页开启一条永远等不到播放器的记录。
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        ) {
          dramaTiming.beginPlayback(drama.id, 'cover', undefined, { ...coverTiming.current! });
        }
        prefetchPlayback(drama.id, browseQueue);
      }}
      className="group flex flex-col overflow-hidden rounded-[16px] border border-border bg-card text-left shadow-lg transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-2xl active:scale-95"
      aria-label={`查看 ${drama.title}`}
    >
      <div
        className="relative aspect-[3/4] w-full shrink-0 overflow-hidden"
        style={{ background: gradient }}
      >
        {showCover ? (
          // eslint-disable-next-line @next/next/no-img-element -- 远程缩略图，走 next/image 要额外配置域名白名单，收益不大
          <img
            ref={(image) => {
              // SSR/浏览器缓存可能在 hydration 之前完成加载，不能只依赖 onLoad。
              if (image)
                coverTiming.current = image.complete
                  ? {
                      outcome: image.naturalWidth > 0 ? 'loaded' : 'error',
                      loadMs: coverLoadMs(image),
                    }
                  : { outcome: 'pending' };
            }}
            src={drama.cover_url!}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            onLoad={(event) => {
              coverTiming.current = { outcome: 'loaded', loadMs: coverLoadMs(event.currentTarget) };
            }}
            onError={() => {
              coverTiming.current = { outcome: 'error' };
              setCoverFailed(true);
            }}
          />
        ) : null}
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
