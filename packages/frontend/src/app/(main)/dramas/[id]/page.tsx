'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { DramaPlayer } from '@/components/drama/drama-player';
import { useDramaBrowseQueueQuery } from '@/lib/api/drama';
import { dramaTiming } from '@/lib/perf/drama-observer';
import { useHydrateDramaLibrary } from '@/stores/drama-library-store';

export default function DramaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnToHome = searchParams.get('from') === 'feed';
  const selectedVideo = searchParams.get('video');
  const initialVideoId =
    selectedVideo && /^[a-zA-Z0-9_-]{1,100}$/.test(selectedVideo) ? selectedVideo : undefined;
  const acceptInitialVideo = useCallback(() => {
    if (!selectedVideo) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete('video');
    const query = params.toString();
    router.replace(`/dramas/${id}${query ? `?${query}` : ''}`, { scroll: false });
  }, [id, router, searchParams, selectedVideo]);
  const hydrated = useHydrateDramaLibrary();
  const queueQuery = useDramaBrowseQueueQuery();
  const navigating = useRef(false);

  useEffect(() => {
    navigating.current = false;
  }, [id]);

  const queue = queueQuery.data ?? [];
  const index = queue.findIndex((drama) => drama.id === id);
  const previous =
    index > 0
      ? queue
          .slice(0, index)
          .reverse()
          .find((drama) => drama.episode_count > 0)
      : undefined;
  // 深链进入的剧可能已不在列表中，仍允许从列表第一部开始继续观看。
  const next = queue.slice(index + 1).find((drama) => drama.episode_count > 0);

  const navigate = (direction: -1 | 1) => {
    const target = direction === 1 ? next : previous;
    if (!target || navigating.current) return;
    navigating.current = true;
    dramaTiming.beginPlayback(target.id, 'switch');
    // 换剧不堆积历史记录；返回始终直接回到已验收的列表页。
    router.replace(`/dramas/${target.id}${returnToHome ? '?from=feed' : ''}`, { scroll: false });
  };

  if (!hydrated)
    return <div aria-label="正在恢复观看位置" className="fixed inset-0 z-40 bg-black" />;

  return (
    <DramaPlayer
      key={id}
      id={id}
      returnToHome={returnToHome}
      initialVideoId={initialVideoId}
      onInitialVideoAccepted={acceptInitialVideo}
      summary={queue[index]}
      previousTitle={previous?.title}
      nextTitle={next?.title}
      nextDramaId={next?.id}
      queueFailed={queueQuery.isError}
      onRetryQueue={() => void queueQuery.refetch()}
      onNavigate={navigate}
    />
  );
}
