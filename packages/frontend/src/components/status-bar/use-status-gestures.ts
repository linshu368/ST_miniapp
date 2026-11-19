'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

const SETTLE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * 抽屉右滑收起。手指移动时直接改 transform（不走 React 重渲染，面板内容多也不卡），
 * 遮罩随拖动距离变淡；松手看最近 100ms 的速度：快速一甩或拖过 30% 就顺着速度滑出，否则回弹。
 * 只认横向（横向位移明显大于纵向），面板里上下滚动不会误触。
 * 关闭按钮、返回键也走 dismiss()，同一条滑出动画。
 */
export function useSwipeToClose(onClose: () => void) {
  const panelRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closing = useRef(false);
  const frame = useRef(0);
  const gesture = useRef({
    id: -1,
    x: 0,
    y: 0,
    decided: false,
    horizontal: false,
    width: 1,
    dx: 0,
    samples: [] as Array<{ x: number; t: number }>,
  });

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const paint = (dx: number, ms = 0) => {
    const panel = panelRef.current;
    const width = panel?.offsetWidth || 1;
    const transition = (property: string) => (ms ? `${property} ${ms}ms ${SETTLE_EASE}` : 'none');
    if (panel) {
      panel.style.transition = transition('transform');
      panel.style.transform = dx ? `translate3d(${dx}px, 0, 0)` : '';
    }
    if (backdropRef.current) {
      backdropRef.current.style.transition = transition('opacity');
      backdropRef.current.style.opacity = String(Math.max(0, 1 - dx / width));
    }
  };

  /** 滑出后再真正关闭；velocity 是松手时的速度（px/ms），甩得越快滑得越快。 */
  const dismiss = (velocity = 0) => {
    if (closing.current) return;
    closing.current = true;
    cancelAnimationFrame(frame.current);
    const width = panelRef.current?.offsetWidth || 400;
    const target = width + 48; // 连左侧阴影一起滑出屏幕
    const remaining = Math.max(0, target - gesture.current.dx);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ms = reduceMotion
      ? 0
      : Math.round(Math.min(260, Math.max(140, remaining / Math.max(velocity, 1.8))));
    paint(target, ms);
    window.setTimeout(() => onCloseRef.current(), ms);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (closing.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      decided: false,
      horizontal: false,
      width: event.currentTarget.offsetWidth || 1,
      dx: 0,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (g.id !== event.pointerId || closing.current) return;
    const mx = event.clientX - g.x;
    const my = event.clientY - g.y;
    if (!g.decided) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      g.decided = true;
      g.horizontal = mx > 0 && Math.abs(mx) > Math.abs(my) * 1.2;
      if (!g.horizontal) return;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (!g.horizontal) return;
    g.dx = Math.max(0, mx);
    g.samples.push({ x: event.clientX, t: event.timeStamp });
    while (g.samples.length > 2 && event.timeStamp - g.samples[0]!.t > 100) g.samples.shift();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => paint(g.dx));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (g.id !== event.pointerId) return;
    g.id = -1;
    if (!g.horizontal || closing.current) return;
    cancelAnimationFrame(frame.current);
    const first = g.samples[0];
    const last = g.samples[g.samples.length - 1];
    const velocity =
      first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    if (g.dx > g.width * 0.3 || (velocity > 0.4 && g.dx > 12)) dismiss(velocity);
    else paint(0, 300);
  };
  return {
    panelRef,
    backdropRef,
    dismiss,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}

/** 输入框获得焦点（键盘弹起）时为 true，用来隐藏浮动入口，不挡输入框。 */
export function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isField = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'TEXTAREA' ||
        (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox'));
    const onIn = (event: FocusEvent) => setTyping(isField(event.target));
    const onOut = () => setTyping(false);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return typing;
}

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式等拿不到存储：只是"新"点和提示气泡会多显示一次，不影响功能。
  }
}
