'use client';
import type { VideoPlazaPlayback } from '@miniapp/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlazaVideoObserver } from './plaza-video-observer';
import type { PlazaDimensions } from '@/lib/perf/plaza-metrics';
import { loadHlsMediaSource } from '@/lib/hls-media-source';
import {
  useVideoPlazaObservationMutation,
  useVideoPlazaPlaybackMutation,
} from '@/lib/api/video-plaza';

function usePlazaVideoSource(artifactId: string, playback: VideoPlazaPlayback, active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fresh, setFresh] = useState<VideoPlazaPlayback | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshCount = useRef(0);
  const alive = useRef(true);
  const recovering = useRef(false);
  const { mutateAsync: refreshPlayback } = useVideoPlazaPlaybackMutation(artifactId);
  const position = useRef({ seconds: 0, playing: false });
  const recover = useCallback(async () => {
    if (!alive.current || recovering.current) return;
    const node = videoRef.current;
    if (!node || refreshCount.current >= 1) {
      setFailed(true);
      return;
    }
    refreshCount.current++;
    recovering.current = true;
    position.current = { seconds: node.currentTime, playing: !node.paused };
    try {
      const result = await refreshPlayback();
      if (alive.current) {
        setFresh(result.playback);
        setFailed(false);
      }
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      recovering.current = false;
    }
  }, [refreshPlayback]);
  const target = fresh ?? playback;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const node = videoRef.current;
    if (!node || !active) return;
    let disposed = false;
    const restore = () => {
      if (disposed) return;
      if (position.current.seconds > 0) node.currentTime = position.current.seconds;
      if (position.current.playing) void node.play().catch(() => undefined);
    };
    const stop = loadHlsMediaSource(
      node,
      target,
      () => {
        if (node.readyState >= 1) restore();
        else node.addEventListener('loadedmetadata', restore, { once: true });
      },
      () => {
        if (!disposed) void recover();
      },
      undefined,
      {
        startPosition: position.current.seconds || undefined,
        // Modern Apple MMS retains the full ABR ladder; old Apple engines keep native HLS.
        forceHlsOnApple: 'ManagedMediaSource' in window,
      }
    );
    const hidden = () => {
      if (document.visibilityState === 'hidden') {
        position.current = { seconds: node.currentTime, playing: !node.paused };
        node.pause();
      }
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      if (!document.hidden) position.current = { seconds: node.currentTime, playing: !node.paused };
      stop();
      document.removeEventListener('visibilitychange', hidden);
      node.removeEventListener('loadedmetadata', restore);
      node.pause();
      node.removeAttribute('src');
      node.load();
    };
  }, [active, target, recover]);
  return { videoRef, failed, recover, target };
}

function usePlazaVideoObservation(
  videoRef: React.RefObject<HTMLVideoElement>,
  artifactId: string,
  failed: boolean,
  active: boolean,
  route: PlazaDimensions['route'],
  entryStartedAt: number,
  source: VideoPlazaPlayback
) {
  const { mutate: send } = useVideoPlazaObservationMutation();
  const observer = useRef<PlazaVideoObserver>();
  const reports = useRef(0);
  const owner = useRef({ generation: 0 });
  const activities = useRef(0);
  const sourceOwner = useRef<VideoPlazaPlayback>();
  useEffect(() => {
    const lifecycle = owner.current;
    const generation = ++lifecycle.generation;
    if (!videoRef.current || !active) {
      observer.current?.stop(document.hidden ? 'background' : 'interrupted');
      observer.current = undefined;
      return;
    }
    if (observer.current && sourceOwner.current !== source) {
      observer.current.stop('interrupted');
      observer.current = undefined;
    }
    if (!observer.current) {
      const initial = activities.current++ === 0;
      sourceOwner.current = source;
      observer.current = new PlazaVideoObserver(
        videoRef.current,
        { route, media: 'video', entry_kind: initial ? 'initial' : 'continuation' },
        (stage, outcome, duration, count) => {
          if (reports.current++ >= 8) return;
          send({
            artifact_id: artifactId,
            stage,
            outcome,
            duration_ms: Math.min(3_600_000, Math.max(0, duration)),
            ...(count !== undefined ? { count } : {}),
          });
        },
        initial && route === '/create/work/:id' ? entryStartedAt : performance.now()
      );
    }
    const current = observer.current;
    // StrictMode's cleanup/setup pair retains its owner, so it cannot fabricate a page-left.
    return () =>
      queueMicrotask(() => {
        if (lifecycle.generation === generation && observer.current === current) {
          current.stop(document.hidden ? 'background' : 'left');
          observer.current = undefined;
        }
      });
  }, [videoRef, artifactId, active, route, entryStartedAt, send, source]);
  useEffect(() => {
    if (failed) observer.current?.fail();
  }, [failed]);
}

/** Artifact identity owns the player lifecycle; both consumers key this component by artifactId. */
export function PlazaVideoPlayer({
  artifactId,
  playback,
  poster,
  active = true,
  onReady,
  entryStartedAt,
}: {
  artifactId: string;
  playback: VideoPlazaPlayback;
  poster?: string;
  active?: boolean;
  onReady?: () => void;
  entryStartedAt?: number;
}) {
  const [foreground, setForeground] = useState(
    () => typeof document === 'undefined' || !document.hidden
  );
  const [mountedAt] = useState(() => performance.now());
  useEffect(() => {
    const update = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const enabled = active && foreground;
  const source = usePlazaVideoSource(artifactId, playback, enabled);
  const route =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/create/work/')
      ? '/create/work/:id'
      : '/create/studio/:id';
  usePlazaVideoObservation(
    source.videoRef,
    artifactId,
    source.failed,
    enabled,
    route,
    entryStartedAt ?? mountedAt,
    source.target
  );
  const saveData =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  return (
    <>
      <video
        ref={source.videoRef}
        poster={poster}
        controls={active}
        playsInline
        preload={enabled ? (saveData ? 'metadata' : 'auto') : 'none'}
        className="absolute inset-0 size-full object-contain"
        onLoadedData={onReady}
        onError={() => void source.recover()}
      />
      {source.failed ? (
        <p
          role="status"
          className="absolute bottom-12 inset-x-3 rounded-lg bg-black/70 p-2 text-center text-xs text-white"
        >
          视频暂时无法播放，请重新打开后重试
        </p>
      ) : null}
    </>
  );
}
