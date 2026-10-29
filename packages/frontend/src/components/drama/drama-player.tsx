'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  Star,
  Heart,
  MessageCircleMore,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ListVideo,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';

import { EpisodeSheet } from './episode-sheet';
import { DramaTags } from './drama-tags';
import { DramaProgress } from './drama-progress';
import { useDramaSwipe } from './use-drama-swipe';
import { useDramaCommentsPanel } from './comment-sheet';
import {
  useDramaDetailQuery,
  useDramaPlaybackQuery,
  useDramaSocialQuery,
  useDramaLikeMutation,
  usePreloadDramaPlayback,
} from '@/lib/api/drama';
import { resolveNextVideoId } from '@/lib/drama-playback';
import { dramaTiming } from '@/lib/perf/drama-observer';
import { observeDramaMedia } from '@/lib/perf/drama-media';
import type { DramaPlaybackTiming } from '@/lib/perf/drama-timing';
import type { DramaSummary } from '@miniapp/shared';
import { cn } from '@/lib/utils';
import {
  useDramaLibraryStore,
  type DramaProgress as DramaProgressRecord,
} from '@/stores/drama-library-store';

interface DramaPlayerProps {
  id: string;
  embedded?: boolean;
  returnToHome?: boolean;
  initialVideoId?: string;
  onInitialVideoAccepted?: () => void;
  summary?: DramaSummary;
  previousTitle?: string;
  previousCoverUrl?: string;
  nextCoverUrl?: string;
  nextTitle?: string;
  nextDramaId?: string;
  queueFailed: boolean;
  onRetryQueue: () => void;
  onNavigate: (direction: -1 | 1) => void;
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

const ignoreGesture = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(
    target.closest(
      'input, textarea, button:not([data-player-toggle-controls]):not([data-player-picture]):not([data-player-swipe-surface]), a, [data-player-no-swipe], [role="dialog"]'
    )
  );

export function DramaPlayer({
  id,
  embedded = false,
  returnToHome = false,
  initialVideoId,
  onInitialVideoAccepted,
  summary,
  previousTitle,
  previousCoverUrl,
  nextCoverUrl,
  nextTitle,
  nextDramaId,
  queueFailed,
  onRetryQueue,
  onNavigate,
}: DramaPlayerProps) {
  const playbackOwner = embedded ? 'home' : 'detail';
  const router = useRouter();
  const detailQuery = useDramaDetailQuery(id);
  const drama = detailQuery.data;
  const like = useDramaLikeMutation(id);
  const likeBusy = useRef(false);
  const [feedback, setFeedback] = useState('');
  const comments = useDramaCommentsPanel();
  const commentsOpen = comments.open;
  const preload = usePreloadDramaPlayback();
  const preloadedVideo = useRef<string | null>(null);
  const resume = useRef<Pick<DramaProgressRecord, 'videoId' | 'seconds' | 'completed'> | undefined>(
    useDramaLibraryStore.getState().history[id]
  );
  const resumePending = useRef(
    !initialVideoId && Boolean(resume.current && !resume.current.completed)
  );
  const resumeExactPosition = useRef(false);
  const initialSelectionPending = useRef(Boolean(initialVideoId));
  const [activeVideoId, setActiveVideoId] = useState<string | null>(
    () =>
      initialVideoId ??
      (resume.current && !resume.current.completed ? resume.current.videoId : null)
  );
  const saved = useDramaLibraryStore((state) => state.saved.includes(id));
  const toggleSaved = useDramaLibraryStore((state) => state.toggleSaved);
  const speed = useDramaLibraryStore((state) => state.speed);
  const setPlaybackPreferences = useDramaLibraryStore((state) => state.setPlaybackPreferences);
  const [finished, setFinished] = useState(false);
  const detailRef = useRef(drama);
  detailRef.current = drama;
  const mediaOwner = useRef<string | null>(null);
  const sourceCheckpoint = useRef<{
    videoId: string;
    seconds: number;
    paused: boolean;
    retryVersion: number;
  } | null>(null);
  const lastSaved = useRef(0);
  const persistProgress = useRef<(video: HTMLVideoElement, force?: boolean) => void>(() => {});
  persistProgress.current = (video, force = false) => {
    const videoId = mediaOwner.current;
    const videos = detailRef.current?.videos ?? [];
    const index = videos.findIndex((item) => item.id === videoId);
    if (!videoId || index < 0 || !Number.isFinite(video.duration) || video.currentTime <= 0) return;
    if (!force && Date.now() - lastSaved.current < 5000) return;
    lastSaved.current = Date.now();
    useDramaLibraryStore.getState().saveProgress(id, {
      videoId,
      episode: index + 1,
      seconds: video.currentTime,
      duration: video.duration,
      completed: video.ended && index === videos.length - 1,
    });
  };
  // 播放与详情并行，元数据加载不阻塞首集的视频元素挂载或签名请求。
  const playbackQuery = useDramaPlaybackQuery(id, activeVideoId ?? undefined);
  const playback = playbackQuery.data;
  // Likes/comments are not needed for first frame. Start them after playback has
  // either resolved or failed so they cannot compete for the media URL.
  const social = useDramaSocialQuery(id, !playbackQuery.isPending);
  const currentVideoId = playback?.video_id ?? activeVideoId;
  const currentIndex = drama?.videos.findIndex((video) => video.id === currentVideoId) ?? -1;
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(true);
  const muted = useDramaLibraryStore((state) => state.muted);
  const [buffering, setBuffering] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [retryState, setRetryState] = useState<'idle' | 'loading' | 'error'>('idle');
  const retryAttempt = useRef(0);
  const timingRef = useRef<{
    videoId: string | null;
    retryVersion: number;
    flow: DramaPlaybackTiming;
  } | null>(null);
  const mediaTimingRef = useRef<ReturnType<typeof observeDramaMedia> | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [episodeTab, setEpisodeTab] = useState<'episodes' | 'intro'>('episodes');
  const controlsVisible = useDramaLibraryStore((state) => state.playbackControlsVisible);
  const setControlsVisible = useDramaLibraryStore((state) => state.setPlaybackControlsVisible);
  const [scrubbing, setScrubbing] = useState(false);
  const [playbackHint, setPlaybackHint] = useState<'play' | 'pause' | null>(null);
  const engaged = useRef(false);
  const explicitEngagement = useRef(Boolean(initialVideoId));
  const pausedAtEnd = useRef(false);
  const [pointerDown, setPointerDown] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const speedMenu = useRef<HTMLDivElement>(null);
  const speedButton = useRef<HTMLButtonElement>(null);
  const lastPictureTap = useRef<{ at: number; x: number; y: number; timer: number } | null>(null);
  const ignorePictureTapUntil = useRef(0);
  const cancelPictureTap = useCallback(() => {
    if (lastPictureTap.current) window.clearTimeout(lastPictureTap.current.timer);
    lastPictureTap.current = null;
  }, []);
  useEffect(() => cancelPictureTap, [cancelPictureTap]);
  const [pageVisible, setPageVisible] = useState(true);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const surface = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const controlsFooter = useRef<HTMLElement>(null);
  const previousFrame = useRef<HTMLDivElement>(null);
  const nextFrame = useRef<HTMLDivElement>(null);
  const suppressTapUntil = useRef(0);
  const wheel = useRef({ distance: 0, last: 0 });
  const wheelTimer = useRef<number | null>(null);
  const switchLock = useRef(0);
  const modalOpen = episodesOpen || commentsOpen;
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;
  const nextVideoId = resolveNextVideoId(drama?.videos ?? [], currentVideoId);
  const nextPlayableId = drama?.videos.find(
    (video) => video.id === nextVideoId && video.playable
  )?.id;
  const previousPlayableId = drama?.videos
    .slice(0, Math.max(0, currentIndex))
    .reverse()
    .find((video) => video.playable)?.id;
  const pendingAdvance = finished && Boolean(embedded ? nextDramaId : nextPlayableId);
  const noEpisodes =
    drama?.episode_count === 0 || (playback?.video_id === null && !playback.playable);
  const playbackError =
    retryState !== 'idle' ||
    failed ||
    playbackQuery.isError ||
    (playback && !playback.playable && !noEpisodes);

  const swiping = useDramaSwipe({
    surface,
    stage,
    previous: previousFrame,
    next: nextFrame,
    sourceKey: `${id}:${currentVideoId ?? ''}`,
    enabled: !modalOpen && !scrubbing,
    ignore: ignoreGesture,
    canNavigate: (direction) =>
      embedded
        ? Boolean(direction === 1 ? nextTitle : previousTitle)
        : Boolean(direction === 1 ? nextPlayableId : previousPlayableId),
    onNavigate: (direction) => switchPlayback(direction),
    onIntent: (direction) => {
      if (embedded) {
        if (direction === 1 && nextDramaId) preload(nextDramaId);
      } else {
        const target = direction === 1 ? nextPlayableId : previousPlayableId;
        if (target) preload(id, target);
      }
    },
    onMove: () => {
      cancelPictureTap();
      suppressTapUntil.current = Date.now() + 500;
    },
  });

  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(''), 3000);
    return () => window.clearTimeout(timeout);
  }, [feedback]);

  const saveDrama = () => {
    toggleSaved(id);
    setFeedback(saved ? '已取消收藏' : '已收藏，可在「追剧」中找到');
  };
  const toggleLike = async () => {
    if (likeBusy.current) return;
    likeBusy.current = true;
    try {
      await like.mutateAsync(!social.data?.liked);
    } catch {
      setFeedback('点赞没能保存，请再试一次');
    } finally {
      likeBusy.current = false;
    }
  };

  // 被移除或已不可播的历史集数回到首集，避免本地旧记录把用户困在错误页。
  useEffect(() => {
    if (
      drama &&
      activeVideoId &&
      !drama.videos.some((video) => video.id === activeVideoId && video.playable)
    ) {
      resumePending.current = false;
      setActiveVideoId(null);
    }
  }, [drama, activeVideoId]);

  useEffect(() => {
    setRetryState('idle');
    return () => {
      // 换集或退出后，旧的恢复请求不能重新装载媒体。
      retryAttempt.current += 1;
    };
  }, [id, activeVideoId]);

  useEffect(() => {
    if (
      !initialSelectionPending.current ||
      !videoEl ||
      videoEl.readyState < 1 ||
      !currentVideoId ||
      mediaOwner.current !== currentVideoId ||
      currentIndex < 0 ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      return;
    // 指定选集只消费一次；先记下包括0秒在内的新位置，再清理入口参数。
    useDramaLibraryStore.getState().saveProgress(id, {
      videoId: currentVideoId,
      episode: currentIndex + 1,
      seconds: videoEl.currentTime,
      duration,
      completed: false,
    });
    initialSelectionPending.current = false;
    onInitialVideoAccepted?.();
  }, [id, videoEl, currentVideoId, currentIndex, duration, onInitialVideoAccepted]);

  useEffect(() => {
    if (videoEl) {
      // 换 src 会恢复 defaultPlaybackRate；两者一起设置才能跨集保留倍速。
      videoEl.defaultPlaybackRate = speed;
      videoEl.playbackRate = speed;
    }
  }, [speed, videoEl, playback?.play_url]);

  useEffect(() => {
    const flush = () => {
      if (videoEl) persistProgress.current(videoEl, true);
    };
    const hide = () => {
      setPageVisible(document.visibilityState !== 'hidden');
      if (document.visibilityState === 'hidden') {
        flush();
        videoEl?.pause();
      }
    };
    hide();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [videoEl]);

  useEffect(() => {
    const releasePointer = () => setPointerDown(false);
    const hide = () => {
      if (document.visibilityState === 'hidden') releasePointer();
    };
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    window.addEventListener('blur', releasePointer);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('pointerup', releasePointer);
      window.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('blur', releasePointer);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  useEffect(() => {
    if (!playbackHint) return;
    const timer = setTimeout(() => setPlaybackHint(null), 650);
    return () => clearTimeout(timer);
  }, [playbackHint]);

  useEffect(() => {
    if (!videoEl) return;
    let last = performance.now();
    let watched = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(1, (now - last) / 1000);
      last = now;
      if (
        engaged.current ||
        videoEl.paused ||
        videoEl.seeking ||
        videoEl.readyState < 3 ||
        document.visibilityState === 'hidden'
      )
        return;
      watched += elapsed;
      // 计真实观看时间，不把快进跳过的几十秒算成用户已经入戏。
      const threshold = Math.max(3, Math.min(15, videoEl.duration * 0.7));
      if (watched >= threshold || explicitEngagement.current) {
        persistProgress.current(videoEl, true);
        if (useDramaLibraryStore.getState().history[id]) {
          useDramaLibraryStore.getState().markEngaged(id);
          engaged.current = true;
        }
      }
    }, 250);
    return () => clearInterval(timer);
  }, [videoEl, id]);

  useEffect(() => {
    if (modalOpen) {
      wheel.current.distance = 0;
      setSpeedOpen(false);
      cancelPictureTap();
    }
    return () => {
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    };
  }, [modalOpen, cancelPictureTap]);

  useEffect(() => {
    if (!speedOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || speedMenu.current?.contains(event.target)) return;
      // 点画面只收起选择器，不顺带暂停；其他明确按钮仍执行自己的动作。
      if (!event.target.closest('[data-player-toggle-controls], [data-player-picture]'))
        setSpeedOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSpeedOpen(false);
        speedButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [speedOpen]);

  useEffect(() => {
    // 当前组件只推进自己持有的记录；导航后旧组件/旧请求的迟到更新不能抢回新记录。
    if (
      !timingRef.current ||
      timingRef.current.flow.owner !== playbackOwner ||
      timingRef.current.videoId !== activeVideoId ||
      timingRef.current.retryVersion !== retryVersion
    ) {
      timingRef.current = {
        videoId: activeVideoId,
        retryVersion,
        flow: dramaTiming.ensurePlayback(id, activeVideoId ?? undefined, playbackOwner),
      };
    }
    dramaTiming.playbackState(
      timingRef.current.flow,
      playback,
      playbackQuery.isFetching,
      playbackQuery.isError
    );
  }, [
    id,
    activeVideoId,
    playback,
    playbackQuery.isFetching,
    playbackQuery.isError,
    retryVersion,
    playbackOwner,
  ]);

  useEffect(() => {
    if (!videoEl || !playback?.playable || !playback.play_url || retryState !== 'idle') return;
    let cancelled = false;
    cancelPictureTap();
    setFailed(false);
    setPlaybackHint(null);
    pausedAtEnd.current = false;
    setBuffering(true);
    setTime(0);
    setDuration(0);
    setFinished(false);
    const checkpoint = sourceCheckpoint.current;
    const sameEpisode = checkpoint?.videoId === playback.video_id;
    const keepPaused = sameEpisode && checkpoint.paused && checkpoint.retryVersion === retryVersion;
    if (sameEpisode && !resumePending.current) {
      // 网络恢复可能自动更新同一集的签名，仍需保留原位置与暂停状态。
      resume.current = {
        videoId: checkpoint.videoId,
        seconds: checkpoint.seconds,
        completed: false,
      };
      resumePending.current = true;
      resumeExactPosition.current = true;
    }
    mediaOwner.current = playback.video_id;
    // 上一个 effect 已绑定当前尝试；媒体 effect 仍只跟随原有 src/retry 依赖。
    const timing = timingRef.current!.flow;
    timing.mark('source_set');
    videoEl.src = playback.play_url;
    const mediaTiming = observeDramaMedia(videoEl, playback.play_url, timing);
    mediaTimingRef.current = mediaTiming;
    const start = async () => {
      if (keepPaused || document.visibilityState === 'hidden') {
        setPaused(true);
        setBuffering(false);
        videoEl.load();
        return;
      }
      mediaTiming.playCalled('automatic');
      try {
        await videoEl.play();
        mediaTiming.resolved('automatic');
      } catch (error: unknown) {
        mediaTiming.rejected(error);
        if (cancelled) return;
        // 浏览器可能禁止有声自动播放，只降级一次；仍失败时保留手动播放入口。
        if (error instanceof DOMException && error.name === 'NotAllowedError' && !videoEl.muted) {
          videoEl.muted = true;
          setPlaybackPreferences({ muted: true });
          try {
            mediaTiming.playCalled('automatic');
            await videoEl.play();
            mediaTiming.resolved('automatic');
            return;
          } catch (retryError: unknown) {
            mediaTiming.rejected(retryError);
          }
        }
        if (!cancelled) {
          setPaused(true);
          setBuffering(false);
          setControlsVisible(true);
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (playback.video_id && Number.isFinite(videoEl.currentTime) && videoEl.readyState >= 1) {
        sourceCheckpoint.current = {
          videoId: playback.video_id,
          seconds: videoEl.currentTime,
          paused: videoEl.paused && (!videoEl.ended || pausedAtEnd.current),
          retryVersion,
        };
      }
      persistProgress.current(videoEl, true);
      mediaOwner.current = null;
      mediaTiming.dispose();
      if (mediaTimingRef.current === mediaTiming) mediaTimingRef.current = null;
      // 换集、换剧或退出立即释放旧媒体，迟到的旧请求不能继续发声。
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    };
  }, [
    videoEl,
    playback?.play_url,
    playback?.playable,
    playback?.video_id,
    retryVersion,
    retryState,
    setPlaybackPreferences,
    cancelPictureTap,
    setControlsVisible,
  ]);

  useEffect(() => {
    if (
      !currentVideoId ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration - time > 3 ||
      preloadedVideo.current === currentVideoId ||
      !drama ||
      !pageVisible
    )
      return;
    if (!embedded && nextPlayableId) {
      preloadedVideo.current = currentVideoId;
      preload(id, nextPlayableId);
    } else if (embedded && nextDramaId) {
      preloadedVideo.current = currentVideoId;
      const progress = useDramaLibraryStore.getState().history[nextDramaId];
      preload(nextDramaId, progress && !progress.completed ? progress.videoId : undefined);
    }
  }, [
    currentVideoId,
    duration,
    time,
    drama,
    nextPlayableId,
    nextDramaId,
    embedded,
    pageVisible,
    preload,
    id,
  ]);

  useEffect(() => {
    // 片尾完整播完才切换；评论不中断续播，选集操作和后台页面暂缓。
    if (
      !pendingAdvance ||
      episodesOpen ||
      !pageVisible ||
      pointerDown ||
      speedOpen ||
      scrubbing ||
      swiping
    )
      return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation = reduceMotion
      ? undefined
      : stage.current?.animate(
          [
            { transform: 'translateY(0)', opacity: 1 },
            { transform: 'translateY(-32px)', opacity: 0.35 },
          ],
          { duration: 160, easing: 'ease-in', fill: 'forwards' }
        );
    const timer = window.setTimeout(
      () => {
        if (!embedded && nextPlayableId) {
          dramaTiming
            .beginPlayback(id, 'episode', nextPlayableId, undefined, 'detail')
            .mark('player_ready');
          resumePending.current = false;
          setActiveVideoId(nextPlayableId);
          setFinished(false);
        } else if (embedded && nextDramaId) {
          navigateRef.current(1);
        }
      },
      reduceMotion ? 0 : 160
    );
    return () => {
      window.clearTimeout(timer);
      animation?.cancel();
    };
  }, [
    pendingAdvance,
    episodesOpen,
    pageVisible,
    pointerDown,
    speedOpen,
    scrubbing,
    swiping,
    embedded,
    nextPlayableId,
    nextDramaId,
    id,
  ]);

  const togglePlayback = () => {
    if (!videoEl || !playback?.playable || playbackError) return;
    cancelPictureTap();
    setFinished(false);
    if (!controlsVisible) setPlaybackHint(videoEl.paused ? 'play' : 'pause');
    if (videoEl.paused) {
      timingRef.current?.flow.mediaEvent('user_play');
      const mediaTiming = mediaTimingRef.current;
      mediaTiming?.playCalled('user');
      void videoEl
        .play()
        .then(() => mediaTiming?.resolved('user'))
        .catch((error: unknown) => {
          mediaTiming?.rejected(error, 'user');
          setPaused(true);
          setBuffering(false);
        });
    } else {
      timingRef.current?.flow.mediaEvent('user_pause');
      videoEl.pause();
    }
  };

  const retryPlayback = async () => {
    if (retryState === 'loading') return;
    const attempt = ++retryAttempt.current;
    if (videoEl) {
      videoEl.pause();
      persistProgress.current(videoEl, true);
    }
    const progress = useDramaLibraryStore.getState().history[id];
    if (progress?.videoId === currentVideoId) {
      resume.current = progress;
      resumePending.current = !progress.completed;
      resumeExactPosition.current = !progress.completed;
    }
    const timing = dramaTiming.beginPlayback(
      id,
      'retry',
      activeVideoId ?? undefined,
      undefined,
      playbackOwner
    );
    timing.mark('player_ready');
    timing.mediaEvent('user_retry');
    setRetryState('loading');
    // 等新地址就绪再装载一次，避免先重放旧地址、随后又从头加载新地址。
    const result = await playbackQuery.refetch();
    if (attempt !== retryAttempt.current) return;
    if (result.isError || !result.data?.playable || !result.data.play_url) {
      setRetryState('error');
      return;
    }
    setFailed(false);
    setRetryVersion((value) => value + 1);
    setRetryState('idle');
  };

  const selectEpisode = (videoId: string) => {
    if (embedded) {
      if (videoEl) persistProgress.current(videoEl, true);
      useDramaLibraryStore.getState().markEngaged(id);
      useDramaLibraryStore.getState().setBrowse({ activeId: id });
      setEpisodesOpen(false);
      router.push(`/dramas/${id}?from=feed&video=${encodeURIComponent(videoId)}`);
      return;
    }
    explicitEngagement.current = true;
    if (videoEl) persistProgress.current(videoEl, true);
    if (useDramaLibraryStore.getState().history[id]) {
      useDramaLibraryStore.getState().markEngaged(id);
      engaged.current = true;
    }
    setFinished(false);
    resumePending.current = false;
    setEpisodesOpen(false);
    if (videoId !== currentVideoId) {
      retryAttempt.current += 1;
      setRetryState('idle');
      videoEl?.pause();
      dramaTiming
        .beginPlayback(id, 'episode', videoId, undefined, playbackOwner)
        .mark('player_ready');
      setActiveVideoId(videoId);
      setFailed(false);
      setBuffering(true);
    }
  };

  const switchDrama = (direction: -1 | 1) => {
    if (modalOpen || Date.now() - switchLock.current < 700) return;
    if (!(direction === 1 ? nextTitle : previousTitle)) return;
    switchLock.current = Date.now();
    retryAttempt.current += 1;
    setSpeedOpen(false);
    videoEl?.pause();
    onNavigate(direction);
  };

  const switchPlayback = (direction: -1 | 1) => {
    if (embedded) return switchDrama(direction);
    const target = direction === 1 ? nextPlayableId : previousPlayableId;
    if (target && !modalOpen) selectEpisode(target);
  };

  const showControls = () => {
    setControlsVisible(true);
  };

  const handlePictureTap = (event: MouseEvent<HTMLButtonElement>) => {
    if (modalOpen || Date.now() < ignorePictureTapUntil.current) return;
    if (speedOpen) {
      setSpeedOpen(false);
      return;
    }
    const last = lastPictureTap.current;
    const now = Date.now();
    // 等双击窗口结束才改变界面；双击只操作播放，不先闪开/闪关控件。
    if (
      last &&
      now - last.at < 320 &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < 48
    ) {
      cancelPictureTap();
      togglePlayback();
      return;
    }
    cancelPictureTap();
    const timer = window.setTimeout(() => {
      lastPictureTap.current = null;
      setControlsVisible((visible) => !visible);
    }, 320);
    lastPictureTap.current = { at: now, x: event.clientX, y: event.clientY, timer };
  };

  const resumeFromIcon = () => {
    cancelPictureTap();
    togglePlayback();
    // 第二击可能落到刚消失的图标下方，不能再触发一次画面操作。
    ignorePictureTapUntil.current = Date.now() + 320;
  };

  const info = drama ?? summary;
  const episodeNumber = Math.max(1, currentIndex + 1);
  const overlayVisible = controlsVisible || Boolean(playbackError);

  useEffect(() => {
    const frame = stage.current;
    const footer = controlsFooter.current;
    if (!frame || !footer || !overlayVisible) {
      frame?.style.removeProperty('--drama-center-y');
      return;
    }
    // 小屏信息区更高，播放按钮留在可观看区域，不能被简介或进度挡住。
    const position = () => {
      const y = Math.min(
        frame.clientHeight / 2,
        Math.max(90, (frame.clientHeight - footer.offsetHeight + 60) / 2)
      );
      frame.style.setProperty('--drama-center-y', `${y}px`);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(frame);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      frame.style.removeProperty('--drama-center-y');
    };
  }, [overlayVisible]);

  return (
    <div
      className={cn(
        'overflow-hidden bg-black text-[#eee7e2]',
        embedded ? 'absolute inset-0' : 'fixed inset-0 z-40'
      )}
    >
      <div
        ref={surface}
        tabIndex={0}
        aria-label={`短剧播放画面，单击切换纯净模式，双击播放或暂停，上下滑${embedded ? '切换短剧' : '切换集数'}`}
        className="relative mx-auto h-full w-full max-w-lg overflow-hidden overscroll-none bg-zinc-950 [touch-action:pan-x_pinch-zoom]"
        onPointerDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          // 新的一次按下代表明确新操作，不再吞掉上次滑动后立即点击的选集/返回。
          suppressTapUntil.current = 0;
          setPointerDown(true);
        }}
        onClickCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          // 滑动起点可以是简介/选集等按钮，但滑动完成不能再误触按钮的 click。
          if (Date.now() < suppressTapUntil.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          // 画面自行区分单/双击；中央图标与其他明确按钮保持独立操作。
          if (
            event.target instanceof Element &&
            event.target.closest('[data-player-toggle-controls], [data-player-picture]')
          )
            return;
          cancelPictureTap();
          showControls();
        }}
        onKeyDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          showControls();
          if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            if (!event.repeat) togglePlayback();
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
              switchPlayback(wheel.current.distance > 0 ? 1 : -1);
            }
            wheel.current.distance = 0;
          }, 160);
        }}
      >
        {([-1, 1] as const).map((direction) => {
          const neighborTitle = embedded
            ? direction === 1
              ? nextTitle
              : previousTitle
            : info?.title;
          const target = direction === 1 ? nextPlayableId : previousPlayableId;
          const available = embedded ? Boolean(neighborTitle) : Boolean(target);
          const cover = embedded
            ? direction === 1
              ? nextCoverUrl
              : previousCoverUrl
            : info?.cover_url;
          return (
            <div
              key={direction}
              ref={direction === 1 ? nextFrame : previousFrame}
              data-drama-neighbor={direction}
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden bg-[#131114]"
              style={{ transform: `translateY(${direction * 100}%)` }}
            >
              {available ? (
                <>
                  {cover ? (
                    <img
                      src={cover}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      fetchPriority="low"
                      className="h-full w-full object-cover opacity-60"
                    />
                  ) : null}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-black/20" />
                  <div className="absolute inset-x-6 bottom-24 text-[#eee7e2]">
                    <p className="text-lg font-semibold">{neighborTitle}</p>
                    {!embedded ? (
                      <p className="mt-2 text-sm text-white/60">
                        第 {(drama?.videos.findIndex((video) => video.id === target) ?? 0) + 1} 集
                      </p>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
        <div
          ref={stage}
          data-drama-stage
          className="relative h-full w-full bg-black [will-change:transform]"
        >
          <video
            ref={setVideoEl}
            className={cn(
              'absolute inset-x-0 top-0 w-full transition-[height] duration-200 motion-reduce:transition-none',
              commentsOpen
                ? 'h-[28dvh] object-contain'
                : cn('h-full', embedded ? 'object-cover' : 'object-contain')
            )}
            playsInline
            muted={muted}
            preload="auto"
            poster={info?.cover_url ?? undefined}
            aria-label={info ? `${info.title}，第 ${episodeNumber} 集` : '短剧播放器'}
            onPlaying={() => {
              if (document.visibilityState === 'hidden') {
                videoEl?.pause();
                return;
              }
              pausedAtEnd.current = false;
              setPaused(false);
              setBuffering(false);
            }}
            onPause={(event) => {
              setPaused(true);
              persistProgress.current(event.currentTarget, true);
            }}
            onWaiting={() => setBuffering(true)}
            onCanPlay={() => setBuffering(false)}
            onTimeUpdate={(event) => {
              setTime(event.currentTarget.currentTime);
              persistProgress.current(event.currentTarget);
            }}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const progress = resume.current;
              if (
                resumePending.current &&
                progress?.videoId === mediaOwner.current &&
                Number.isFinite(video.duration)
              ) {
                resumePending.current = false;
                // 重新进入已播完的单集从头看；中断恢复即使临近片尾也不能归零。
                const target =
                  !resumeExactPosition.current && progress.seconds >= video.duration - 0.5
                    ? 0
                    : Math.min(progress.seconds, video.duration);
                resumeExactPosition.current = false;
                if (video.paused && target >= video.duration - 0.05) pausedAtEnd.current = true;
                video.currentTime = target;
                setTime(target);
              }
            }}
            onError={() => {
              if (videoEl?.getAttribute('src')) {
                videoEl.pause();
                setFailed(true);
                setBuffering(false);
              }
            }}
            onEnded={(event) => {
              persistProgress.current(event.currentTarget, true);
              setFinished(!pausedAtEnd.current);
            }}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={controlsVisible ? '隐藏播放控件' : '显示播放控件'}
            data-player-toggle-controls
            className="absolute inset-0 h-full w-full"
            onClick={handlePictureTap}
            onDoubleClick={(event) => event.preventDefault()}
          />
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/90 transition-opacity duration-200 motion-reduce:transition-none',
              overlayVisible ? 'opacity-100' : 'opacity-0'
            )}
          />
          {!embedded && overlayVisible ? (
            <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between [&_button]:pointer-events-auto [&_a]:pointer-events-auto px-4 pt-[calc(0.5rem+env(safe-area-inset-top))]">
              <Link
                href={returnToHome ? '/' : '/dramas'}
                aria-label={returnToHome ? '返回首页' : '返回短剧'}
                onClick={() => {
                  if (videoEl) persistProgress.current(videoEl, true);
                  if (returnToHome) useDramaLibraryStore.getState().setBrowse({ activeId: id });
                }}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-black/20"
              >
                <ArrowLeft className="h-6 w-6" />
              </Link>
              <p className="text-sm font-medium text-[#eee7e2]/80">
                第 {episodeNumber} 集{' '}
                <span className="text-[#eee7e2]/35">/ {info?.episode_count ?? '—'}</span>
              </p>
              <button
                type="button"
                aria-label="查看全部选集"
                onClick={() => {
                  setEpisodeTab('episodes');
                  setEpisodesOpen(true);
                }}
                disabled={!drama?.videos.length}
                className="flex h-11 w-11 items-center justify-center disabled:opacity-30"
              >
                <ListVideo className="h-[22px] w-[22px]" />
              </button>
            </header>
          ) : null}

          {!controlsVisible && playbackHint && !buffering ? (
            <div
              role="status"
              aria-label={playbackHint === 'pause' ? '已暂停' : '继续播放中'}
              className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/20 p-4 text-white/75"
            >
              {playbackHint === 'pause' ? (
                <Pause aria-hidden className="h-10 w-10 fill-current" />
              ) : (
                <Play aria-hidden className="h-10 w-10 fill-current" />
              )}
            </div>
          ) : null}

          <div className="pointer-events-none absolute inset-x-5 top-[var(--drama-center-y,50%)] z-10 flex -translate-y-1/2 flex-col items-center justify-center gap-3 text-center [&_button]:pointer-events-auto">
            {noEpisodes ? (
              <>
                <ClapperboardPlaceholder />
                <p className="text-sm text-[#eee7e2]/75">这部剧还在准备中</p>
                {nextTitle ? (
                  <button
                    type="button"
                    onClick={() => switchDrama(1)}
                    className="min-h-11 rounded-full bg-white px-6 text-sm font-semibold text-black"
                  >
                    先看下一部
                  </button>
                ) : null}
              </>
            ) : playbackError ? (
              <>
                <AlertCircle className="h-8 w-8 text-[#eee7e2]/60" />
                <p className="text-sm">
                  {retryState === 'loading' ? '正在接着刚才的位置恢复' : '播放暂时中断了'}
                </p>
                <button
                  type="button"
                  onClick={() => void retryPlayback()}
                  disabled={retryState === 'loading'}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black disabled:opacity-60"
                >
                  <RefreshCw
                    className={cn(
                      'h-4 w-4',
                      retryState === 'loading' && 'animate-spin motion-reduce:animate-none'
                    )}
                  />
                  {retryState === 'loading' ? '正在恢复' : '重新播放'}
                </button>
              </>
            ) : !scrubbing && (buffering || playbackQuery.isLoading || pendingAdvance) ? (
              <Loader2
                aria-label="视频加载中"
                className="h-7 w-7 animate-spin text-[#eee7e2]/75 motion-reduce:animate-none"
              />
            ) : paused && controlsVisible && !scrubbing ? (
              <button
                type="button"
                aria-label="继续播放"
                data-player-picture
                onClick={resumeFromIcon}
                onDoubleClick={(event) => event.preventDefault()}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-black/20"
              >
                <Play className="ml-1 h-11 w-11 fill-[#eee7e2]/80 stroke-1 text-[#eee7e2]/80" />
              </button>
            ) : null}
          </div>

          {overlayVisible ? (
            <>
              <aside
                aria-label="短剧互动"
                className={cn(
                  'pointer-events-none absolute right-2 z-20 flex flex-col items-center gap-2 [&_button]:pointer-events-auto',
                  embedded ? 'bottom-[188px]' : 'bottom-[232px]'
                )}
                data-player-no-swipe
              >
                <button
                  type="button"
                  aria-label={saved ? '取消收藏' : '收藏这部剧'}
                  aria-pressed={saved}
                  onClick={saveDrama}
                  className="flex min-h-14 min-w-12 flex-col items-center justify-center gap-1 text-[11px] drop-shadow-md active:scale-95 motion-reduce:transform-none"
                >
                  <Star
                    className={cn(
                      'h-[30px] w-[30px] stroke-[1.5]',
                      saved ? 'fill-[#d9afb8] text-[#d9afb8]' : 'fill-[#eee7e2] text-[#eee7e2]'
                    )}
                  />
                  <span>{saved ? '已收藏' : '收藏'}</span>
                </button>
                <button
                  type="button"
                  aria-label="打开评论"
                  onClick={() => comments.show(id, info?.title ?? '短剧')}
                  className="flex min-h-14 min-w-12 flex-col items-center justify-center gap-1 text-[11px] drop-shadow-md active:scale-95 motion-reduce:transform-none"
                >
                  <MessageCircleMore className="h-[30px] w-[30px] stroke-[1.8]" />
                  <span>
                    {social.data?.comment_count ? formatCount(social.data.comment_count) : '评论'}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={social.data?.liked ? '取消点赞' : '点赞这部剧'}
                  aria-pressed={social.data?.liked ?? false}
                  aria-busy={like.isPending}
                  onClick={() => void toggleLike()}
                  className="flex min-h-14 min-w-12 flex-col items-center justify-center gap-1 text-[11px] drop-shadow-md active:scale-95 motion-reduce:transform-none"
                >
                  <Heart
                    className={cn(
                      'h-[31px] w-[31px] stroke-[1.5] transition-colors',
                      social.data?.liked
                        ? 'fill-[#dc8195] text-[#dc8195]'
                        : 'fill-[#eee7e2] text-[#eee7e2]'
                    )}
                  />
                  <span>
                    {social.data?.like_count ? formatCount(social.data.like_count) : '点赞'}
                  </span>
                </button>
              </aside>
              <section
                ref={controlsFooter}
                className={cn(
                  'pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pt-6 [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_a]:pointer-events-auto',
                  embedded ? 'pb-2' : 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]'
                )}
              >
                <p
                  role="status"
                  className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-3 py-2 text-xs text-[#eee7e2]/85 empty:hidden"
                >
                  {feedback}
                </p>
                {queueFailed || playbackError ? (
                  <div className="mb-1 flex min-h-8 items-center justify-between gap-3 text-[11px] text-[#eee7e2]/50">
                    <span>
                      {queueFailed ? (
                        <button
                          type="button"
                          onClick={onRetryQueue}
                          className="min-h-11 text-[#d3adb5]"
                        >
                          重新加载换剧列表
                        </button>
                      ) : null}
                    </span>
                    <div className="-mr-2 flex shrink-0" data-player-no-swipe>
                      <button
                        type="button"
                        aria-label="上一部短剧"
                        disabled={!previousTitle}
                        onClick={() => switchDrama(-1)}
                        className="flex h-11 w-11 items-center justify-center disabled:opacity-20"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="下一部短剧"
                        disabled={!nextTitle}
                        onClick={() => switchDrama(1)}
                        className="flex h-11 w-11 items-center justify-center disabled:opacity-20"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : null}
                {info ? (
                  <>
                    <button
                      type="button"
                      aria-label="查看完整简介"
                      data-player-swipe-surface
                      onClick={() => {
                        setEpisodeTab('intro');
                        setEpisodesOpen(true);
                      }}
                      className="block w-full pb-3 pr-12 text-left"
                    >
                      <h1 className="flex items-center gap-1 text-[20px] font-semibold leading-7">
                        <span className="line-clamp-1">{info.title}</span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-[#eee7e2]/55" />
                      </h1>
                      <div className="mt-1.5 flex items-center gap-2">
                        <DramaTags tags={info.tags} variant="player" />
                        <span className="shrink-0 py-0.5 text-[10px] text-[#eee7e2]/40">
                          第 {episodeNumber} 集
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-1 text-xs leading-5 text-[#eee7e2]/70">
                        {info.description}
                      </p>
                    </button>
                    {drama?.videos.length ? (
                      <>
                        {embedded ? (
                          <Link
                            href={`/dramas/${id}?from=feed`}
                            aria-label={`观看完整短剧 ${info.title}`}
                            onClick={() => {
                              if (videoEl) persistProgress.current(videoEl, true);
                              useDramaLibraryStore.getState().markEngaged(id);
                              useDramaLibraryStore.getState().setBrowse({ activeId: id });
                            }}
                            className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-white/[0.07] px-3 text-left text-sm font-medium text-[#eee7e2] active:bg-white/10"
                          >
                            <Play aria-hidden className="h-4 w-4 fill-current" />
                            观看完整短剧{' '}
                            <span className="text-xs font-normal text-[#eee7e2]/40">
                              · 全 {info.episode_count} 集
                            </span>
                            <ChevronRight className="ml-auto h-4 w-4 text-[#eee7e2]/60" />
                          </Link>
                        ) : null}
                        <EpisodeSheet
                          showTrigger={!embedded}
                          title={drama.title}
                          description={drama.description}
                          tags={drama.tags}
                          coverUrl={drama.cover_url}
                          saved={saved}
                          onToggleSaved={saveDrama}
                          tab={episodeTab}
                          onTabChange={setEpisodeTab}
                          videos={drama.videos}
                          currentVideoId={currentVideoId}
                          open={episodesOpen}
                          onOpenChange={setEpisodesOpen}
                          onSelect={selectEpisode}
                        />
                      </>
                    ) : null}
                  </>
                ) : detailQuery.isError ? (
                  <div role="alert" className="text-sm text-[#eee7e2]/70">
                    短剧信息加载失败{' '}
                    <button
                      type="button"
                      onClick={() => void detailQuery.refetch()}
                      className="min-h-11 px-2 text-[#d3adb5]"
                    >
                      重试
                    </button>
                  </div>
                ) : (
                  <div
                    aria-label="短剧信息加载中"
                    className="mb-3 h-12 animate-pulse rounded-lg bg-white/10"
                  />
                )}
                {!noEpisodes && !playbackError ? (
                  <div data-player-no-swipe className="pointer-events-auto">
                    <DramaProgress
                      video={videoEl}
                      time={time}
                      duration={duration}
                      sourceKey={currentVideoId ?? ''}
                      onScrubbingChange={setScrubbing}
                      onCommit={(seconds, wasPlaying) => {
                        pausedAtEnd.current = !wasPlaying && seconds >= duration - 0.05;
                        setTime(seconds);
                        setFinished(false);
                        if (videoEl) persistProgress.current(videoEl, true);
                      }}
                    />
                    <div className="-mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={paused ? '播放视频' : '暂停视频'}
                        onClick={togglePlayback}
                        disabled={!playback?.playable}
                        className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-30"
                      >
                        {paused ? (
                          <Play className="h-3.5 w-3.5 fill-[#eee7e2]" />
                        ) : (
                          <Pause className="h-3.5 w-3.5 fill-[#eee7e2]" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={muted ? '打开声音' : '关闭声音'}
                        aria-pressed={!muted}
                        onClick={() => setPlaybackPreferences({ muted: !muted })}
                        className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center text-[#eee7e2]/70"
                      >
                        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                      </button>
                      <span className="shrink-0 text-[10px] tabular-nums text-[#eee7e2]/60">
                        {formatTime(time)} / {formatTime(duration)}
                      </span>
                      <div ref={speedMenu} className="relative -mr-2 ml-auto shrink-0">
                        {speedOpen ? (
                          <div
                            role="group"
                            aria-label="选择播放速度"
                            className="pointer-events-auto absolute bottom-full right-0 z-30 mb-2 flex rounded-xl border border-white/10 bg-[#211f22] p-1 shadow-xl"
                          >
                            {[1, 1.25, 1.5, 2].map((value) => (
                              <button
                                key={value}
                                type="button"
                                aria-label={`${value} 倍`}
                                aria-pressed={speed === value}
                                onClick={() => {
                                  setPlaybackPreferences({ speed: value });
                                  setSpeedOpen(false);
                                  speedButton.current?.focus();
                                }}
                                className={cn(
                                  'flex h-11 min-w-12 items-center justify-center rounded-lg px-2 text-xs tabular-nums',
                                  speed === value
                                    ? 'bg-[#c99ea7]/15 text-[#dbb2bb]'
                                    : 'text-[#eee7e2]/70 active:bg-white/5'
                                )}
                              >
                                {value}×
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <button
                          ref={speedButton}
                          type="button"
                          aria-label={`播放速度 ${speed} 倍，点击选择`}
                          aria-expanded={speedOpen}
                          onClick={() => setSpeedOpen((open) => !open)}
                          className="flex h-11 min-w-11 items-center justify-center text-[11px] font-medium text-[#eee7e2]/75"
                        >
                          {speed === 1 ? '倍速' : `${speed}×`}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ClapperboardPlaceholder() {
  return <ListVideo className="h-8 w-8 text-[#eee7e2]/40" />;
}

function formatCount(count: number) {
  return count >= 10000 ? `${(count / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(count);
}
