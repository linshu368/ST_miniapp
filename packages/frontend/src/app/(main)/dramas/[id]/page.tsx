'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertCircle, Play, RefreshCw } from 'lucide-react';

import { useDramaDetailQuery, useDramaPlaybackQuery } from '@/lib/api/drama';
import { resolveNextVideoId } from '@/lib/drama-playback';

export default function DramaDetailPage() {
  const { id } = useParams<{ id: string }>();

  const detailQuery = useDramaDetailQuery(id);
  const drama = detailQuery.data;
  const videos = drama?.videos ?? [];

  // null 表示"交给后端按默认顺序选第一集"，不需要等详情回来才知道放哪一集。
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const playbackQuery = useDramaPlaybackQuery(id, activeVideoId ?? undefined);
  const playback = playbackQuery.data;

  const currentVideoId = playback?.video_id ?? activeVideoId;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  // 播完后自动连播前的缓冲倒计时；用下标而不是 episode 字段算第几集，
  // 因为 episode 目前全库为空（见 repository.ts 注释），下标才是实际播放顺序。
  const [autoAdvance, setAutoAdvance] = useState<{
    nextVideoId: string;
    nextEpisodeNumber: number;
    secondsLeft: number;
  } | null>(null);

  useEffect(() => {
    if (!autoAdvance) return;
    if (autoAdvance.secondsLeft <= 0) {
      setActiveVideoId(autoAdvance.nextVideoId);
      setAutoAdvance(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setAutoAdvance((prev) => (prev ? { ...prev, secondsLeft: prev.secondsLeft - 1 } : prev));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [autoAdvance]);

  // 拿到签名链接立刻设 src 并尝试播放；这是同步 DOM 的 video 元素，不是数据获取。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback?.playable || !playback.play_url) return;
    video.src = playback.play_url;
    setPlaybackFailed(false);
    setNeedsTapToPlay(false);
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      // Telegram WebView/部分移动浏览器会拦截非用户手势触发的 autoplay，
      // 拦截时退化成"点击播放"覆盖层，而不是静默黑屏。
      playPromise.catch(() => setNeedsTapToPlay(true));
    }
  }, [playback?.play_url, playback?.playable]);

  const handleEnded = () => {
    const nextVideoId = resolveNextVideoId(videos, currentVideoId);
    if (!nextVideoId) return;
    const nextEpisodeNumber = videos.findIndex((v) => v.id === nextVideoId) + 1;
    setAutoAdvance({ nextVideoId, nextEpisodeNumber, secondsLeft: 3 });
  };

  const handleCancelAutoAdvance = () => setAutoAdvance(null);

  const handlePlayNextNow = () => {
    if (!autoAdvance) return;
    setActiveVideoId(autoAdvance.nextVideoId);
    setAutoAdvance(null);
  };

  const handleTapToPlay = () => {
    const video = videoRef.current;
    if (!video) return;
    video
      .play()
      .then(() => setNeedsTapToPlay(false))
      .catch(() => setNeedsTapToPlay(true));
  };

  if (detailQuery.isLoading) {
    return <DramaDetailSkeleton />;
  }

  if (detailQuery.isError || !drama) {
    return <DramaDetailError onRetry={() => void detailQuery.refetch()} />;
  }

  const noEpisodes = drama.episode_count === 0;

  return (
    <main className="mx-auto min-h-dvh w-full max-w-screen-xl px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))] text-foreground">
      <div className="relative aspect-[9/16] w-full max-w-md overflow-hidden rounded-2xl bg-black">
        {noEpisodes ? (
          <NoEpisodesNotice />
        ) : playback && !playback.playable ? (
          <PlaybackFailedNotice onRetry={() => void playbackQuery.refetch()} />
        ) : playbackFailed || playbackQuery.isError ? (
          <PlaybackFailedNotice onRetry={() => void playbackQuery.refetch()} />
        ) : (
          <>
            <video
              ref={videoRef}
              className="h-full w-full object-contain"
              playsInline
              controls
              onEnded={handleEnded}
              onError={() => setPlaybackFailed(true)}
            />
            {needsTapToPlay ? (
              <button
                type="button"
                onClick={handleTapToPlay}
                className="absolute inset-0 flex items-center justify-center bg-black/40"
                aria-label="点击播放"
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/90">
                  <Play className="h-7 w-7 fill-black text-black" />
                </span>
              </button>
            ) : null}
            {autoAdvance ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/65 text-center text-white">
                <p className="text-sm">
                  {autoAdvance.secondsLeft} 秒后播放第 {autoAdvance.nextEpisodeNumber} 集
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCancelAutoAdvance}
                    className="rounded-full border border-white/40 px-4 py-1.5 text-xs font-semibold text-white/90 transition active:scale-95"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handlePlayNextNow}
                    className="rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-black transition active:scale-95"
                  >
                    立即播放
                  </button>
                </div>
              </div>
            ) : null}
            {playbackQuery.isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-sm text-white">
                加载中…
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="mx-auto mt-4 max-w-md">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">{drama.title}</h1>
          {drama.episode_count > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              共 {drama.episode_count} 集
            </span>
          ) : null}
        </div>
        <div className="mt-3 rounded-2xl border border-border bg-card p-3">
          <p className="text-xs font-semibold text-muted-foreground">简介</p>
          <p className="mt-1 whitespace-pre-line text-sm text-foreground/90">
            {drama.description || '简介整理中'}
          </p>
        </div>
        {drama.tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {drama.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-foreground/[0.06] px-2.5 py-1 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function NoEpisodesNotice() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-sm text-white/80">
      <AlertCircle className="h-8 w-8 text-white/60" />
      暂无可用集数
    </div>
  );
}

function PlaybackFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center text-sm text-white/80">
      <AlertCircle className="h-8 w-8 text-white/60" />
      播放链接加载失败，请重试
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        <RefreshCw className="h-4 w-4" />
        重试
      </button>
    </div>
  );
}

function DramaDetailSkeleton() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-screen-xl px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))]">
      <div className="aspect-[9/16] w-full max-w-md animate-pulse rounded-2xl border border-border bg-card" />
    </main>
  );
}

function DramaDetailError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-screen-xl flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm text-destructive">短剧加载失败，请稍后重试。</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        <RefreshCw className="h-4 w-4" />
        重试
      </button>
    </main>
  );
}
