'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

type Direction = -1 | 1;
interface Options {
  surface: RefObject<HTMLDivElement>;
  stage: RefObject<HTMLDivElement>;
  previous: RefObject<HTMLDivElement>;
  next: RefObject<HTMLDivElement>;
  sourceKey: string;
  enabled: boolean;
  ignore: (target: EventTarget | null) => boolean;
  canNavigate: (direction: Direction) => boolean;
  onNavigate: (direction: Direction) => void;
  onIntent: (direction: Direction) => void;
  onMove: () => void;
}

/** 手指只推动合成层；相邻画面使用封面，不创建第二个播放中的视频。 */
export function useDramaSwipe(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [active, setActive] = useState(false);
  const cancel = useRef<() => void>(() => {});

  useEffect(() => {
    const element = latest.current.surface.current;
    if (!element) return;
    let gesture: {
      x: number;
      y: number;
      height: number;
      axis: 'pending' | 'vertical' | 'horizontal';
      lastY: number;
      lastAt: number;
      velocity: number;
      intent: Direction | null;
    } | null = null;
    let settling: 'none' | 'returning' | 'committing' = 'none';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paint = (offset: number, height: number, duration = 0) => {
      const { stage, previous, next } = latest.current;
      for (const [ref, shift] of [
        [stage, 0],
        [previous, -height],
        [next, height],
      ] as const) {
        if (!ref.current) continue;
        ref.current.style.transition = duration
          ? `transform ${duration}ms cubic-bezier(.2,.75,.25,1)`
          : 'none';
        ref.current.style.transform = `translate3d(0, ${offset + shift}px, 0)`;
      }
    };
    const reset = (animate: boolean) => {
      clearTimeout(timer);
      gesture = null;
      const duration = animate && !reduced() ? 180 : 0;
      paint(0, element.clientHeight, duration);
      settling = duration > 0 ? 'returning' : 'none';
      timer = setTimeout(() => {
        settling = 'none';
        setActive(false);
      }, duration);
    };
    cancel.current = () => reset(false);
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset(true);
        return;
      }
      if (
        settling === 'committing' ||
        !latest.current.enabled ||
        latest.current.ignore(event.target)
      )
        return;
      const touch = event.touches[0]!;
      // 回弹也能被下一次动作接住，不能因为用户划得快就吞掉一划。
      const offset =
        settling === 'returning' && latest.current.stage.current
          ? new DOMMatrixReadOnly(getComputedStyle(latest.current.stage.current).transform).m42
          : 0;
      clearTimeout(timer);
      settling = 'none';
      paint(offset, element.clientHeight);
      gesture = {
        x: touch.clientX,
        y: touch.clientY - offset,
        height: element.clientHeight,
        axis: offset ? 'vertical' : 'pending',
        lastY: touch.clientY,
        lastAt: event.timeStamp,
        velocity: 0,
        intent: null,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || !latest.current.enabled) {
        reset(true);
        return;
      }
      const touch = event.touches[0]!;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (Math.hypot(dx, dy) > 10) latest.current.onMove();
      if (gesture.axis === 'pending' && Math.max(Math.abs(dx), Math.abs(dy)) > 10) {
        if (Math.abs(dy) > Math.abs(dx) * 1.3) gesture.axis = 'vertical';
        else if (Math.abs(dx) >= Math.abs(dy)) gesture.axis = 'horizontal';
      }
      if (gesture.axis !== 'vertical') return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const direction: Direction = dy < 0 ? 1 : -1;
      const allowed = latest.current.canNavigate(direction);
      if (gesture.intent !== direction) {
        gesture.intent = direction;
        setActive(true);
        if (allowed) latest.current.onIntent(direction);
      }
      const elapsed = event.timeStamp - gesture.lastAt;
      if (elapsed >= 8) gesture.velocity = (touch.clientY - gesture.lastY) / elapsed;
      gesture.lastY = touch.clientY;
      gesture.lastAt = event.timeStamp;
      const offset = allowed
        ? Math.sign(dy) * Math.min(Math.abs(dy), gesture.height * 0.95)
        : Math.sign(dy) * Math.min(60, Math.abs(dy) * 0.18);
      paint(offset, gesture.height);
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      gesture = null;
      if (!current || current.axis !== 'vertical') return;
      if (event.touches.length) return reset(true);
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      latest.current.onMove();
      const touch = event.changedTouches[0];
      if (!touch) return reset(true);
      const dy = touch.clientY - current.y;
      const direction: Direction = dy < 0 ? 1 : -1;
      const distanceEnough = Math.abs(dy) >= Math.min(120, Math.max(70, current.height * 0.17));
      const fastFlick =
        Math.abs(dy) >= 28 &&
        event.timeStamp - current.lastAt < 100 &&
        Math.abs(current.velocity) > 0.55 &&
        Math.sign(current.velocity) === Math.sign(dy);
      if (
        !latest.current.enabled ||
        !latest.current.canNavigate(direction) ||
        (!distanceEnough && !fastFlick)
      ) {
        reset(true);
        return;
      }
      settling = 'committing';
      const duration = reduced() ? 0 : 190;
      paint(-direction * current.height, current.height, duration);
      timer = setTimeout(() => {
        if (!latest.current.enabled || document.visibilityState === 'hidden') return reset(false);
        latest.current.onNavigate(direction);
        // 请求失败或目标失效时也不能把当前画面永久移出屏幕。
        timer = setTimeout(() => reset(false), 900);
      }, duration);
    };
    const cancelled = () => reset(true);
    const multiTouch = (event: TouchEvent) => {
      if (gesture && event.touches.length > 1) {
        latest.current.onMove();
        reset(true);
      }
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') reset(false);
    };
    element.addEventListener('touchstart', start, { capture: true, passive: true });
    element.addEventListener('touchmove', move, { capture: true, passive: false });
    element.addEventListener('touchend', end, { capture: true, passive: false });
    element.addEventListener('touchcancel', cancelled, { capture: true });
    document.addEventListener('visibilitychange', hidden);
    const blur = () => reset(false);
    window.addEventListener('blur', blur);
    document.addEventListener('touchstart', multiTouch, { capture: true, passive: true });
    paint(0, element.clientHeight);
    return () => {
      clearTimeout(timer);
      element.removeEventListener('touchstart', start, true);
      element.removeEventListener('touchmove', move, true);
      element.removeEventListener('touchend', end, true);
      element.removeEventListener('touchcancel', cancelled, true);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', blur);
      document.removeEventListener('touchstart', multiTouch, true);
    };
  }, []);

  useEffect(() => {
    cancel.current();
  }, [options.sourceKey, options.enabled]);
  return active;
}
