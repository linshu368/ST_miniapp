'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * 抽屉右滑收起：跟手移动，滑过宽度 1/4 或快速一甩就收起，否则弹回。
 * 只认横向（横向位移明显大于纵向），面板里上下滚动不会误触。
 */
export function useSwipeToClose(onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const state = useRef({ x: 0, y: 0, t: 0, decided: false, horizontal: false, width: 1 });
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    state.current = {
      x: event.clientX,
      y: event.clientY,
      t: performance.now(),
      decided: false,
      horizontal: false,
      width: event.currentTarget.offsetWidth || 1,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const s = state.current;
    if (!s.t) return;
    const mx = event.clientX - s.x;
    const my = event.clientY - s.y;
    if (!s.decided && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      s.decided = true;
      s.horizontal = mx > 0 && Math.abs(mx) > Math.abs(my) * 1.2;
      if (s.horizontal) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }
    }
    if (s.horizontal) setOffset(Math.max(0, mx));
  };
  const onPointerEnd = () => {
    const s = state.current;
    if (s.horizontal) {
      const speed = offset / Math.max(1, performance.now() - s.t);
      if (offset > s.width * 0.25 || speed > 0.5) onClose();
      else setOffset(0);
    }
    state.current = { ...s, t: 0, decided: false, horizontal: false };
    setDragging(false);
  };
  return {
    offset,
    dragging,
    reset: () => setOffset(0),
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
