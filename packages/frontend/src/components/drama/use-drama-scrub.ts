'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

/**
 * 指针松手提交后，原生 range 紧接着还会再触发一次 onChange（Android 上约 31% 的快进会因此
 * 在 50ms 内被几乎同一目标的第二次提交替换）。此时拖动会话已清空，拦不住，所以松手后的
 * 一小段时间内忽略 onChange。键盘走 onKeyDown，不受影响。
 */
const POINTER_COMMIT_ECHO_MS = 500;

export interface DramaScrubProps {
  video: HTMLVideoElement | null;
  time: number;
  duration: number;
  sourceKey: string;
  onScrubbingChange: (scrubbing: boolean) => void;
  onCommit: (seconds: number, wasPlaying: boolean) => void;
  onBeforeCommit?: (seconds: number, wasPlaying: boolean) => void;
}

interface ScrubSession {
  pointerId: number;
  video: HTMLVideoElement;
  sourceKey: string;
  source: string;
  wasPlaying: boolean;
  value: number;
}

/** 宽触区先预览、松手再定位，避免手指拖动持续触发媒体请求或误换剧。 */
export function useDramaScrub(
  props: DramaScrubProps,
  input: RefObject<HTMLInputElement | null>,
  options: { disabled: boolean; validDuration: number; onStart: () => void }
) {
  const { video, time, sourceKey } = props;
  const { disabled, validDuration } = options;
  const latest = useRef(props);
  latest.current = props;
  const onStart = useRef(options.onStart);
  onStart.current = options.onStart;
  const session = useRef<ScrubSession | null>(null);
  const pendingResume = useRef<ScrubSession | null>(null);
  const lastPointerCommitAt = useRef(Number.NEGATIVE_INFINITY);
  const [preview, setPreview] = useState<number | null>(null);
  const visibleTime = Math.min(
    validDuration,
    Math.max(0, preview ?? (Number.isFinite(time) ? time : 0))
  );

  const cancelResume = useCallback(() => {
    const pending = pendingResume.current;
    pendingResume.current = null;
    if (
      pending &&
      latest.current.video === pending.video &&
      latest.current.sourceKey === pending.sourceKey &&
      (pending.video.currentSrc || pending.video.src) === pending.source
    ) {
      pending.video.pause();
    }
  }, []);

  const finish = useCallback(
    (commit: boolean, resume: boolean) => {
      const current = session.current;
      if (!current) return;
      session.current = null;
      const sameMedia =
        latest.current.video === current.video &&
        latest.current.sourceKey === current.sourceKey &&
        (current.video.currentSrc || current.video.src) === current.source;
      if (commit && sameMedia) {
        lastPointerCommitAt.current = performance.now();
        latest.current.onBeforeCommit?.(current.value, current.wasPlaying);
        current.video.currentTime = current.value;
        latest.current.onCommit(current.value, current.wasPlaying);
      }
      setPreview(null);
      latest.current.onScrubbingChange(false);
      if (input.current?.hasPointerCapture(current.pointerId)) {
        input.current.releasePointerCapture(current.pointerId);
      }
      // 原来暂停的内容仍暂停；换源、离页和卸载都不能被迟到的恢复动作抢播。
      if (resume && sameMedia && current.wasPlaying && document.visibilityState !== 'hidden') {
        pendingResume.current = current;
        void current.video
          .play()
          .then(() => {
            if (pendingResume.current === current) pendingResume.current = null;
          })
          .catch(() => {
            if (pendingResume.current === current) pendingResume.current = null;
            // 浏览器拒绝播放时保留已定位画面，由原播放器的播放入口继续。
          });
      }
    },
    [input]
  );

  useEffect(() => {
    const cancelOnHide = () => {
      if (document.visibilityState === 'hidden') {
        cancelResume();
        finish(false, false);
      }
    };
    const cancelSecondPointer = (event: globalThis.PointerEvent) => {
      if (session.current && event.pointerId !== session.current.pointerId) finish(false, true);
    };
    const cancelOnBlur = () => {
      cancelResume();
      finish(false, false);
    };
    document.addEventListener('visibilitychange', cancelOnHide);
    document.addEventListener('pointerdown', cancelSecondPointer, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      cancelResume();
      finish(false, false);
      document.removeEventListener('visibilitychange', cancelOnHide);
      document.removeEventListener('pointerdown', cancelSecondPointer, true);
      window.removeEventListener('blur', cancelOnBlur);
    };
  }, [finish, cancelResume, video, sourceKey]);

  const position = (clientX: number) => {
    const box = input.current?.getBoundingClientRect();
    if (!box?.width) return visibleTime;
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * validDuration;
  };

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLInputElement>) => {
      if (disabled || !video || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onStart.current();
      pendingResume.current = null;
      const value = position(event.clientX);
      session.current = {
        pointerId: event.pointerId,
        video,
        sourceKey,
        source: video.currentSrc || video.src,
        wasPlaying: !video.paused && !video.ended,
        value,
      };
      latest.current.onScrubbingChange(true);
      video.pause();
      setPreview(value);
      event.currentTarget.focus({ preventScroll: true });
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 宿主已取消触点时恢复原状态，不能留下一根无人能松开的进度条。
        finish(false, true);
      }
    },
    onPointerMove: (event: PointerEvent<HTMLInputElement>) => {
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      current.value = position(event.clientX);
      setPreview(current.value);
    },
    onPointerUp: (event: PointerEvent<HTMLInputElement>) => {
      if (session.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      session.current.value = position(event.clientX);
      finish(true, true);
    },
    onPointerCancel: (event: PointerEvent<HTMLInputElement>) => {
      if (session.current?.pointerId === event.pointerId) finish(false, true);
    },
    onLostPointerCapture: (event: PointerEvent<HTMLInputElement>) => {
      if (
        session.current?.pointerId === event.pointerId &&
        !event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        finish(false, true);
      }
    },
  };

  return {
    preview,
    visibleTime,
    handlers,
    /** 正在拖动：此时的 onChange / 键盘提交都应忽略。 */
    isScrubbing: () => session.current !== null,
    /** 刚由指针松手提交过：紧随其后的原生 onChange 是同一次手势的回声。 */
    isPointerCommitEcho: () =>
      performance.now() - lastPointerCommitAt.current < POINTER_COMMIT_ECHO_MS,
  };
}
