'use client';

import { useEffect, useRef, useState } from 'react';

const DISMISS_DISTANCE = 72;
const INTENT_DISTANCE = 10;
const isInteractive = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest('button, a, input, textarea, select, [role="button"]'));

/** 仅标题区拥有收起手势，列表滚动与按钮点击继续由原控件处理。 */
export function useDramaSheetDismiss(open: boolean, onOpenChange: (open: boolean) => void) {
  // Radix Portal 可能晚一帧挂载，以实际节点为依赖，避免首次打开漏绑手势。
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [handle, setHandle] = useState<HTMLDivElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open || !content || !handle) return;

    let gesture: { id: number; x: number; y: number } | null = null;
    let suppressClickUntil = 0;
    content.style.transition = 'none';
    content.style.translate = '0 0';

    const returnToRest = () => {
      gesture = null;
      content.style.transition = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'none'
        : 'translate 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      content.style.translate = '0 0';
    };
    const cancelMultitouch = (event: TouchEvent) => {
      if (gesture && event.touches.length !== 1) returnToRest();
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || isInteractive(event.target)) {
        returnToRest();
        return;
      }
      const touch = event.touches[0]!;
      content.style.transition = 'none';
      content.style.translate = '0 0';
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!gesture || !touch) return;
      if (event.touches.length !== 1 || touch.identifier !== gesture.id) {
        returnToRest();
        return;
      }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (Math.hypot(dx, dy) < INTENT_DISTANCE) return;
      suppressClickUntil = Date.now() + 400;
      if (dy <= 0 || dy < Math.abs(dx) * 1.4) {
        returnToRest();
        return;
      }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      // 轻微阻尼，不把整张评论列表拖动渲染成逐帧 React 更新。
      content.style.translate = `0 ${Math.min(160, dy * 0.7)}px`;
    };
    const end = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!gesture || !touch) return;
      const { id, x, y } = gesture;
      const dx = touch.clientX - x;
      const dy = touch.clientY - y;
      if (event.touches.length || touch.identifier !== id) {
        returnToRest();
        return;
      }
      if (dy >= DISMISS_DISTANCE && dy > Math.abs(dx) * 1.4) {
        gesture = null;
        suppressClickUntil = Date.now() + 400;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        // 保留松手位移，让 Radix 自身的退出动画自然接走，不先跳回原位。
        onOpenChangeRef.current(false);
      } else {
        returnToRest();
      }
    };
    const suppressDragClick = (event: MouseEvent) => {
      if (!isInteractive(event.target) && Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener('touchstart', cancelMultitouch, { capture: true, passive: true });
    handle.addEventListener('touchstart', start, { capture: true, passive: true });
    handle.addEventListener('touchmove', move, { capture: true, passive: false });
    handle.addEventListener('touchend', end, { capture: true, passive: false });
    handle.addEventListener('touchcancel', returnToRest, true);
    handle.addEventListener('click', suppressDragClick, true);
    return () => {
      gesture = null;
      document.removeEventListener('touchstart', cancelMultitouch, true);
      handle.removeEventListener('touchstart', start, true);
      handle.removeEventListener('touchmove', move, true);
      handle.removeEventListener('touchend', end, true);
      handle.removeEventListener('touchcancel', returnToRest, true);
      handle.removeEventListener('click', suppressDragClick, true);
    };
  }, [open, content, handle]);

  return { contentRef: setContent, handleRef: setHandle };
}
