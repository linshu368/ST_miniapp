'use client';

import { useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { DramaPlayer } from '@/components/drama/drama-player';
import { useDramaBrowseQueueQuery } from '@/lib/api/drama';

export default function DramaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
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
    // 换剧不堆积历史记录；返回始终直接回到已验收的列表页。
    router.replace(`/dramas/${target.id}`, { scroll: false });
  };

  return (
    <DramaPlayer
      key={id}
      id={id}
      previousTitle={previous?.title}
      nextTitle={next?.title}
      queueLoading={queueQuery.isLoading}
      queueFailed={queueQuery.isError}
      onRetryQueue={() => void queueQuery.refetch()}
      onNavigate={navigate}
    />
  );
}
