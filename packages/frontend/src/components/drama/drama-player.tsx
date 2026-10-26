'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

import { EpisodeSheet } from './episode-sheet';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { useDramaDetailQuery, useDramaPlaybackQuery } from '@/lib/api/drama';
import { resolveDramaSwipeDirection, resolveNextVideoId } from '@/lib/drama-playback';
import { suspendTelegramVerticalSwipes } from '@/lib/telegram';

interface DramaPlayerProps {
  id: string;
  previousTitle?: string;
  nextTitle?: string;
  queueLoading: boolean;
  queueFailed: boolean;
  onRetryQueue: () => void;
  onNavigate: (direction: -1 | 1) => void;
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function DramaPlayer({
  id,
  previousTitle,
  nextTitle,
  queueLoading,
  queueFailed,
  onRetryQueue,
  onNavigate,
}: DramaPlayerProps) {
  const detailQuery = useDramaDetailQuery(id);
  const drama = detailQuery.data;
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  // 播放与详情并行，元数据加载不阻塞首集的视频元素挂载或签名请求。
  const playbackQuery = useDramaPlaybackQuery(id, activeVideoId ?? undefined);
  const playback = playbackQuery.data;
  const currentVideoId = playback?.video_id ?? activeVideoId;
  const currentIndex = drama?.videos.findIndex((video) => video.id === currentVideoId) ?? -1;
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [activity, setActivity] = useState(0);
  const [pointerDown, setPointerDown] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [advance, setAdvance] = useState<{ id: string; number: number; seconds: number } | null>(
    null
  );
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const suppressTapUntil = useRef(0);
  const wheel = useRef({ distance: 0, last: 0 });
  const wheelTimer = useRef<number | null>(null);
  const switchLock = useRef(0);
  const modalOpen = episodesOpen || descriptionOpen;
  const noEpisodes =
    drama?.episode_count === 0 || (playback?.video_id === null && !playback.playable);
  const playbackError =
    failed || playbackQuery.isError || (playback && !playback.playable && !noEpisodes);

  useEffect(() => suspendTelegramVerticalSwipes(), []);

  useEffect(() => {
    // 拖动、面板和键盘操作期间不收起；结束后重新给用户完整的 3 秒。
    if (modalOpen || pointerDown || keyboardActive) return;
    const timer = window.setTimeout(() => setControlsVisible(false), 3000);
    return () => window.clearTimeout(timer);
  }, [activity, modalOpen, pointerDown, keyboardActive]);

  useEffect(() => {
    const releasePointer = () => setPointerDown(false);
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    const element = surface.current;
    const preventVerticalScroll = (event: TouchEvent) => {
      const start = gesture.current;
      const touch = event.touches[0];
      if (!start || !touch || event.touches.length !== 1 || !event.cancelable) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      // React 的 touchmove 可能是 passive，原生非 passive 监听才能阻止浏览器下拉刷新。
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.3) event.preventDefault();
    };
    element?.addEventListener('touchmove', preventVerticalScroll, { passive: false });
    return () => {
      window.removeEventListener('pointerup', releasePointer);
      window.removeEventListener('pointercancel', releasePointer);
      element?.removeEventListener('touchmove', preventVerticalScroll);
    };
  }, []);

  useEffect(() => {
    if (modalOpen) {
      gesture.current = null;
      wheel.current.distance = 0;
    }
    return () => {
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    };
  }, [modalOpen]);

  useEffect(() => {
    if (!videoEl || !playback?.playable || !playback.play_url) return;
    let cancelled = false;
    setFailed(false);
    setBuffering(true);
    setTime(0);
    setDuration(0);
    videoEl.src = playback.play_url;
    void videoEl.play().catch(() => {
      if (!cancelled) {
        setPaused(true);
        setBuffering(false);
      }
    });
    return () => {
      cancelled = true;
      // 换集、换剧或退出立即释放旧媒体，迟到的旧请求不能继续发声。
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    };
  }, [videoEl, playback?.play_url, playback?.playable, retryVersion]);

  useEffect(() => {
    if (!advance || modalOpen) return;
    const timer = window.setTimeout(() => {
      if (advance.seconds <= 1) {
        setActiveVideoId(advance.id);
        setAdvance(null);
      } else {
        setAdvance({ ...advance, seconds: advance.seconds - 1 });
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [advance, modalOpen]);

  const togglePlayback = () => {
    if (!videoEl) return;
    setAdvance(null);
    if (videoEl.paused) {
      void videoEl.play().catch(() => {
        setPaused(true);
        setBuffering(false);
      });
    } else videoEl.pause();
  };

  const selectEpisode = (videoId: string) => {
    setAdvance(null);
    setEpisodesOpen(false);
    if (videoId !== currentVideoId) {
      videoEl?.pause();
      setActiveVideoId(videoId);
      setFailed(false);
      setBuffering(true);
    }
  };

  const switchDrama = (direction: -1 | 1) => {
    if (modalOpen || Date.now() - switchLock.current < 700) return;
    if (!(direction === 1 ? nextTitle : previousTitle)) return;
    switchLock.current = Date.now();
    setAdvance(null);
    videoEl?.pause();
    onNavigate(direction);
  };

  const ignoreGesture = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(target.closest('input, [data-player-no-swipe], [role="dialog"]'));

  const showControls = () => {
    setControlsVisible(true);
    setActivity((value) => value + 1);
  };

  return (
    <main className="fixed inset-0 z-40 overflow-hidden bg-black text-white">
      <div
        ref={surface}
        tabIndex={0}
        aria-label="短剧播放画面，点击显示控件，上下滑切换短剧"
        className="relative mx-auto h-full w-full max-w-lg overflow-hidden overscroll-none bg-zinc-950 [touch-action:pan-x_pinch-zoom]"
        onPointerDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          setPointerDown(true);
          setKeyboardActive(false);
        }}
        onClickCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          // 滑动起点可以是简介/选集等按钮，但滑动完成不能再误触按钮的 click。
          if (Date.now() < suppressTapUntil.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          showControls();
        }}
        onKeyDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          setKeyboardActive(true);
          showControls();
          if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
            event.preventDefault();
          }
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setKeyboardActive(false);
          }
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          gesture.current =
            !modalOpen && !ignoreGesture(event.target) && event.touches.length === 1 && touch
              ? { x: touch.clientX, y: touch.clientY }
              : null;
        }}
        onTouchCancel={() => {
          gesture.current = null;
        }}
        onTouchMove={(event) => {
          const touch = event.touches[0];
          if (event.touches.length !== 1) {
            gesture.current = null;
            return;
          }
          const start = gesture.current;
          if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
            suppressTapUntil.current = Date.now() + 500;
          }
        }}
        onTouchEnd={(event) => {
          const start = gesture.current;
          gesture.current = null;
          const end = event.changedTouches[0];
          if (!start || !end) return;
          const direction = resolveDramaSwipeDirection(
            end.clientX - start.x,
            end.clientY - start.y
          );
          if (direction) {
            suppressTapUntil.current = Date.now() + 500;
            switchDrama(direction);
          }
        }}
        onWheel={(event) => {
          if (
            modalOpen ||
            ignoreGesture(event.target) ||
            event.ctrlKey ||
            Math.abs(event.deltaX) > Math.abs(event.deltaY)
          )
            return;
          const now = Date.now();
          setActivity((value) => value + 1);
          // 等滚动惯性结束再换剧，避免新路由把惯性尾部当成第二次手势。
          const delta =
            event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1);
          const continuing = now - wheel.current.last < 180;
          wheel.current = {
            distance: continuing ? wheel.current.distance + delta : delta,
            last: now,
          };
          if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
          wheelTimer.current = window.setTimeout(() => {
            if (Math.abs(wheel.current.distance) >= 90) {
              switchDrama(wheel.current.distance > 0 ? 1 : -1);
            }
            wheel.current.distance = 0;
          }, 160);
        }}
      >
        <video
          ref={setVideoEl}
          className="absolute inset-0 h-full w-full object-contain"
          playsInline
          muted={muted}
          preload="metadata"
          poster={drama?.cover_url ?? undefined}
          aria-label={
            drama ? `${drama.title}，第 ${Math.max(1, currentIndex + 1)} 集` : '短剧播放器'
          }
          onPlaying={() => {
            setPaused(false);
            setBuffering(false);
          }}
          onPause={() => setPaused(true)}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          onError={() => {
            if (videoEl?.getAttribute('src')) {
              setFailed(true);
              setBuffering(false);
            }
          }}
          onEnded={() => {
            const nextId = resolveNextVideoId(drama?.videos ?? [], currentVideoId);
            if (nextId)
              setAdvance({
                id: nextId,
                number: (drama?.videos.findIndex((video) => video.id === nextId) ?? 0) + 1,
                seconds: 3,
              });
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="显示播放控件"
          className="absolute inset-0 h-full w-full"
          onClick={showControls}
        />
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 bg-gradient-to-b from-black/65 via-transparent to-black/95 transition-opacity duration-200 motion-reduce:transition-none ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}
        />
        {controlsVisible ? (
          <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))]">
            <Link
              href="/dramas"
              aria-label="返回短剧列表"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/35"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <p className="text-xs font-semibold text-white/85" aria-live="polite">
              {currentIndex >= 0 ? `第 ${currentIndex + 1} / ${drama?.videos.length} 集` : '短剧'}
            </p>
            <button
              type="button"
              aria-label={muted ? '打开声音' : '关闭声音'}
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/35"
            >
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
          </header>
        ) : null}

        <div className="pointer-events-none absolute inset-x-4 top-[24%] flex h-[20%] flex-col items-center justify-center gap-3 text-center [&_button]:pointer-events-auto">
          {noEpisodes ? (
            <>
              <AlertCircle className="h-8 w-8 text-white/60" />
              <p className="text-sm">暂无可用集数</p>
            </>
          ) : playbackError ? (
            <>
              <AlertCircle className="h-8 w-8 text-white/60" />
              <p className="text-sm">播放失败，请重试</p>
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setRetryVersion((value) => value + 1);
                  void playbackQuery.refetch();
                }}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground"
              >
                <RefreshCw className="h-4 w-4" />
                重新播放
              </button>
            </>
          ) : advance ? (
            <div className="rounded-2xl border border-white/15 bg-black/70 p-5">
              <p className="mb-4 text-sm">
                {advance.seconds} 秒后播放第 {advance.number} 集
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setAdvance(null)}
                  className="min-h-11 rounded-full border border-white/25 px-4 text-sm"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => selectEpisode(advance.id)}
                  className="min-h-11 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground"
                >
                  立即播放
                </button>
              </div>
            </div>
          ) : buffering || playbackQuery.isLoading ? (
            <Loader2
              aria-label="视频加载中"
              className="h-8 w-8 animate-spin text-white/80 motion-reduce:animate-none"
            />
          ) : paused && controlsVisible ? (
            <button
              type="button"
              aria-label="播放视频"
              onClick={togglePlayback}
              className="flex h-16 w-16 items-center justify-center rounded-full border border-white/25 bg-black/35"
            >
              <Play className="ml-1 h-8 w-8 fill-white" />
            </button>
          ) : null}
        </div>

        {controlsVisible ? (
          <section className="absolute inset-x-0 bottom-0 z-10 space-y-3 px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-8">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!nextTitle || modalOpen}
                aria-label={nextTitle ? `下一部：${nextTitle}` : '没有更多短剧'}
                onClick={() => switchDrama(1)}
                className="inline-flex min-h-11 items-center gap-1 rounded-full border border-white/15 bg-black/30 px-3 text-xs text-white/80 disabled:opacity-60"
              >
                <ChevronUp className="h-4 w-4" />
                {queueLoading
                  ? '正在加载更多短剧…'
                  : queueFailed
                    ? '换剧列表暂不可用'
                    : nextTitle
                      ? '上滑看下一部剧'
                      : '已是最后一部剧'}
              </button>
              <button
                type="button"
                disabled={!previousTitle || modalOpen}
                aria-label={previousTitle ? `上一部：${previousTitle}` : '没有上一部短剧'}
                onClick={() => switchDrama(-1)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/30 disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
            {queueFailed ? (
              <button
                type="button"
                onClick={onRetryQueue}
                className="min-h-11 text-xs text-primary"
              >
                重新加载换剧列表
              </button>
            ) : null}
            {detailQuery.isLoading ? (
              <div
                aria-label="短剧信息加载中"
                className="h-16 animate-pulse rounded-xl bg-white/10 motion-reduce:animate-none"
              />
            ) : drama ? (
              <>
                <h1 className="line-clamp-2 text-2xl font-bold leading-tight tracking-tight">
                  {drama.title}
                </h1>
                {drama.tags.length ? (
                  <div className="flex gap-1.5 overflow-hidden">
                    {drama.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="truncate rounded-md bg-white/10 px-2 py-1 text-[11px] text-white/75"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setDescriptionOpen(true)}
                  aria-label="查看完整简介"
                  className="block w-full text-left text-xs leading-relaxed text-white/65"
                >
                  <span className="line-clamp-1">{drama.description || '简介整理中'}</span>
                </button>
                {drama.videos.length ? (
                  <EpisodeSheet
                    title={drama.title}
                    videos={drama.videos}
                    currentVideoId={currentVideoId}
                    open={episodesOpen}
                    onOpenChange={setEpisodesOpen}
                    onSelect={selectEpisode}
                  />
                ) : null}
              </>
            ) : (
              <div role="alert" className="rounded-xl bg-black/50 p-3 text-sm">
                <p>短剧信息加载失败</p>
                <button
                  type="button"
                  onClick={() => void detailQuery.refetch()}
                  className="min-h-11 text-primary"
                >
                  重新加载信息
                </button>
              </div>
            )}
            {!noEpisodes && !playbackError ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={paused ? '播放视频' : '暂停视频'}
                  onClick={togglePlayback}
                  disabled={!playback?.playable}
                  className="flex h-11 w-8 shrink-0 items-center justify-center disabled:opacity-30"
                >
                  {paused ? (
                    <Play className="h-4 w-4 fill-white" />
                  ) : (
                    <Pause className="h-4 w-4 fill-white" />
                  )}
                </button>
                <input
                  type="range"
                  aria-label="播放进度"
                  min={0}
                  max={Number.isFinite(duration) && duration > 0 ? duration : 0}
                  step={0.1}
                  value={time}
                  disabled={!Number.isFinite(duration) || duration <= 0}
                  onChange={(event) => {
                    if (videoEl) {
                      const value = Number(event.target.value);
                      videoEl.currentTime = value;
                      setTime(value);
                      setAdvance(null);
                    }
                  }}
                  className="h-11 min-w-0 flex-1 accent-primary"
                />
                <span className="shrink-0 text-[10px] tabular-nums text-white/65">
                  {formatTime(time)} / {formatTime(duration)}
                </span>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
      <Sheet open={descriptionOpen} onOpenChange={setDescriptionOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[70dvh] max-w-lg rounded-t-3xl p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] motion-reduce:animate-none"
          overlayClassName="backdrop-blur-none"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <SheetTitle className="text-lg font-semibold">简介</SheetTitle>
            <SheetClose
              aria-label="关闭简介"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground/[0.06]"
            >
              <X className="h-5 w-5" />
            </SheetClose>
          </div>
          <SheetDescription className="mb-3 font-semibold">{drama?.title}</SheetDescription>
          <p className="max-h-[45dvh] overflow-y-auto overscroll-contain whitespace-pre-line text-sm leading-7">
            {drama?.description || '简介整理中'}
          </p>
        </SheetContent>
      </Sheet>
    </main>
  );
}
