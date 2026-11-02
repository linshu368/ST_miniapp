'use client';

import { useEffect } from 'react';
import { Clapperboard, RefreshCw } from 'lucide-react';

import { DramaPlayer } from './drama-player';
import { DramaHomeFrame, DramaHomeLoading } from './drama-home-frame';
import { cn } from '@/lib/utils';
import { useDramaListQuery } from '@/lib/api/drama';
import { markCriticalSettled } from '@/lib/entry-phase';
import { dramaTiming } from '@/lib/perf/drama-observer';
import { useFreshAfterFetch, usePageReady } from '@/lib/perf/page-ready';
import { useDramaLibraryStore, useHydrateDramaLibrary } from '@/stores/drama-library-store';

export function DramaHome() {
  const query = useDramaListQuery('/');
  const hydrated = useHydrateDramaLibrary();
  const controlsVisible = useDramaLibraryStore((state) => state.playbackControlsVisible);
  const activeId = useDramaLibraryStore((state) => state.browse.activeId);
  const setBrowse = useDramaLibraryStore((state) => state.setBrowse);
  const queue = (query.data ?? []).filter((drama) => drama.episode_count > 0);
  const activeIndex = queue.findIndex((drama) => drama.id === activeId);
  const index = activeIndex >= 0 ? activeIndex : 0;
  const current = queue[index];
  const currentId = current?.id;
  // A remembered drama can start its playback request while the catalog refreshes.
  // The refreshed catalog remains authoritative and corrects a removed/stale id.
  const playerId = currentId ?? (query.data === undefined ? activeId : null);
  // 后台推荐刷新失败不影响已有内容，避免正在播放的剧被错误页卸载。
  const hasPlayer = hydrated && Boolean(playerId);
  useEffect(() => {
    // 首次推荐也记住当前剧；后台重排列表不能替用户换掉正在看的内容。
    if (hydrated && currentId && activeId !== currentId) setBrowse({ activeId: currentId });
  }, [hydrated, currentId, activeId, setBrowse]);
  useEffect(() => {
    // 没有视频时也必须能离开，不能把用户留在隐藏导航的错误/空页面。
    if (!hasPlayer) useDramaLibraryStore.getState().setPlaybackControlsVisible(true);
  }, [hasPlayer]);
  const fresh = useFreshAfterFetch(query.isFetching, query.data !== undefined, query.isError);
  usePageReady(
    '/',
    hydrated && query.data !== undefined && (!query.isError || hasPlayer),
    fresh,
    query.isError,
    query.data !== undefined && query.isFetching ? 'cache' : fresh ? 'fetch' : 'unknown'
  );

  useEffect(() => {
    if (query.data !== undefined || query.isError) markCriticalSettled();
    if (query.data) dramaTiming.listReady(query.data, '/');
    else if (query.isError) dramaTiming.listFailed();
  }, [query.data, query.isError]);

  const retry = () => {
    dramaTiming.beginList('retry', undefined, '/');
    void query.refetch();
  };

  return (
    <DramaHomeFrame
      controlsVisible={controlsVisible}
      onBrowse={(tab) => setBrowse({ tab })}
      headerActions={
        hasPlayer && query.isError ? (
          <button
            type="button"
            aria-label="刷新短剧推荐"
            disabled={query.isFetching}
            onClick={retry}
            className="flex h-11 w-11 items-center justify-center text-[#eee7e2]/65 disabled:opacity-40"
          >
            <RefreshCw className={cn('h-[18px] w-[18px]', query.isFetching && 'animate-spin')} />
          </button>
        ) : null
      }
    >
      {!hydrated || (query.isLoading && !playerId) ? (
        <DramaHomeLoading />
      ) : !playerId ? (
        <div
          role="status"
          className="flex h-full flex-col items-center justify-center px-8 text-center"
        >
          <Clapperboard className="mb-5 h-10 w-10 text-[#eee7e2]/30" />
          <h2 className="text-lg font-semibold">
            {query.isError ? '短剧暂时没加载出来' : '好戏，即将开场'}
          </h2>
          <p className="mt-2 text-sm text-[#eee7e2]/45">
            {query.isError
              ? '网络可能开了个小差，再试一次就好。'
              : '短剧正在陆续上架，稍后回来看看。'}
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-6 min-h-11 rounded-full bg-[#dfd2cf] px-6 text-sm font-semibold text-black"
          >
            {query.isError ? '重新加载' : '刷新看看'}
          </button>
        </div>
      ) : (
        <DramaPlayer
          key={playerId}
          id={playerId}
          summary={current?.id === playerId ? current : undefined}
          embedded
          previousTitle={queue[index - 1]?.title}
          previousCoverUrl={queue[index - 1]?.cover_url ?? undefined}
          nextTitle={queue[index + 1]?.title}
          nextCoverUrl={queue[index + 1]?.cover_url ?? undefined}
          nextDramaId={queue[index + 1]?.id}
          queueFailed={false}
          onRetryQueue={retry}
          onNavigate={(direction) => {
            const target = queue[index + direction];
            if (!target) return;
            dramaTiming.beginPlayback(target.id, 'switch', undefined, undefined, 'home');
            setBrowse({ activeId: target.id });
          }}
        />
      )}
    </DramaHomeFrame>
  );
}
