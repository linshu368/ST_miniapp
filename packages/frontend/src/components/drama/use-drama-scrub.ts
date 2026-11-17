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

interface ScrubGesture {
  input: RefObject<HTMLInputElement | null>;
  latest: { current: DramaScrubProps };
  onStart: { current: () => void };
  session: { current: ScrubSession | null };
  pendingResume: { current: ScrubSession | null };
  lastPointerCommitAt: { current: number };
  disabled: boolean;
  validDuration: number;
  video: HTMLVideoElement | null;
  sourceKey: string;
  visibleTime: number;
  setPreview: (value: number | null) => void;
}

function isSameScrubMedia(latest: DramaScrubProps, current: ScrubSession) {
  return (
    latest.video === current.video &&
    latest.sourceKey === current.sourceKey &&
    (current.video.currentSrc || current.video.src) === current.source
  );
}

function cancelPendingResume(gesture: ScrubGesture) {
  const pending = gesture.pendingResume.current;
  gesture.pendingResume.current = null;
  if (pending && isSameScrubMedia(gesture.latest.current, pending)) pending.video.pause();
}

/** 松手提交或中断拖动。原来暂停的内容仍暂停；换源、离页和卸载都不能被迟到的恢复动作抢播。 */
function finishScrub(gesture: ScrubGesture, commit: boolean, resume: boolean) {
  const current = gesture.session.current;
  if (!current) return;
  gesture.session.current = null;
  const sameMedia = isSameScrubMedia(gesture.latest.current, current);
  if (commit && sameMedia) {
    gesture.lastPointerCommitAt.current = performance.now();
    gesture.latest.current.onBeforeCommit?.(current.value, current.wasPlaying);
    current.video.currentTime = current.value;
    gesture.latest.current.onCommit(current.value, current.wasPlaying);
  }
  gesture.setPreview(null);
  gesture.latest.current.onScrubbingChange(false);
  if (gesture.input.current?.hasPointerCapture(current.pointerId)) {
    gesture.input.current.releasePointerCapture(current.pointerId);
  }
  if (resume && sameMedia && current.wasPlaying && document.visibilityState !== 'hidden') {
    gesture.pendingResume.current = current;
    void current.video
      .play()
      .then(() => {
        if (gesture.pendingResume.current === current) gesture.pendingResume.current = null;
      })
      .catch(() => {
        if (gesture.pendingResume.current === current) gesture.pendingResume.current = null;
        // 浏览器拒绝播放时保留已定位画面，由原播放器的播放入口继续。
      });
  }
}

function scrubPosition(gesture: ScrubGesture, clientX: number) {
  const box = gesture.input.current?.getBoundingClientRect();
  if (!box?.width) return gesture.visibleTime;
  return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * gesture.validDuration;
}

function scrubPointerHandlers(
  gesture: { current: ScrubGesture },
  finish: (commit: boolean, resume: boolean) => void
) {
  return {
    onPointerDown: (event: PointerEvent<HTMLInputElement>) => {
      const current = gesture.current;
      if (current.disabled || !current.video || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      current.onStart.current();
      current.pendingResume.current = null;
      const value = scrubPosition(current, event.clientX);
      current.session.current = {
        pointerId: event.pointerId,
        video: current.video,
        sourceKey: current.sourceKey,
        source: current.video.currentSrc || current.video.src,
        wasPlaying: !current.video.paused && !current.video.ended,
        value,
      };
      current.latest.current.onScrubbingChange(true);
      current.video.pause();
      current.setPreview(value);
      event.currentTarget.focus({ preventScroll: true });
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 宿主已取消触点时恢复原状态，不能留下一根无人能松开的进度条。
        finish(false, true);
      }
    },
    onPointerMove: (event: PointerEvent<HTMLInputElement>) => {
      const current = gesture.current.session.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      current.value = scrubPosition(gesture.current, event.clientX);
      gesture.current.setPreview(current.value);
    },
    onPointerUp: (event: PointerEvent<HTMLInputElement>) => {
      const current = gesture.current;
      if (current.session.current?.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      current.session.current.value = scrubPosition(current, event.clientX);
      finish(true, true);
    },
    onPointerCancel: (event: PointerEvent<HTMLInputElement>) => {
      if (gesture.current.session.current?.pointerId === event.pointerId) finish(false, true);
    },
    onLostPointerCapture: (event: PointerEvent<HTMLInputElement>) => {
      const current = gesture.current.session.current;
      if (
        current?.pointerId === event.pointerId &&
        !event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        finish(false, true);
      }
    },
  };
}

/** 第二指、页面隐藏或窗口失焦时结束拖动，避免迟到的恢复把已经离开的视频重新播起来。 */
function useScrubInterrupt(
  session: { current: ScrubSession | null },
  finish: (commit: boolean, resume: boolean) => void,
  cancelResume: () => void,
  video: HTMLVideoElement | null,
  sourceKey: string
) {
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
  }, [finish, cancelResume, video, sourceKey, session]);
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
  const snapshot: ScrubGesture = {
    input,
    latest,
    onStart,
    session,
    pendingResume,
    lastPointerCommitAt,
    disabled,
    validDuration,
    video,
    sourceKey,
    visibleTime,
    setPreview,
  };
  const gesture = useRef(snapshot);
  gesture.current = snapshot;

  const cancelResume = useCallback(() => cancelPendingResume(gesture.current), []);
  const finish = useCallback(
    (commit: boolean, resume: boolean) => finishScrub(gesture.current, commit, resume),
    []
  );
  useScrubInterrupt(session, finish, cancelResume, video, sourceKey);

  return {
    preview,
    visibleTime,
    handlers: scrubPointerHandlers(gesture, finish),
    /** 正在拖动：此时的 onChange / 键盘提交都应忽略。 */
    isScrubbing: () => session.current !== null,
    /** 刚由指针松手提交过：紧随其后的原生 onChange 是同一次手势的回声。 */
    isPointerCommitEcho: () =>
      performance.now() - lastPointerCommitAt.current < POINTER_COMMIT_ECHO_MS,
  };
}
