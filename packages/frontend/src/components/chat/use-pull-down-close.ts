'use client';

import { useEffect, useRef } from 'react';

/** 到顶后再下拉多少（手指实际移动距离）松手就收起。 */
const CLOSE_DISTANCE = 64;
const MAX_SHIFT = 120;

/**
 * 可滚动面板已经在顶部时继续下拉：内容跟手下移（带阻尼）并变淡，拉够了松手就收起，不够就弹回。
 * 中途滚到顶部再接着下拉也算，从到顶那一刻开始计距离；往回推则恢复正常滚动。
 * 直接改 transform，不走 React 重渲染；在输入框里起手的不处理，免得打字时误收。
 */
export function usePullDownToClose(scroller: HTMLElement | null, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!scroller) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let touchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let pullFrom: number | null = null;
    let pull = 0;
    let ignored = false;

    const paint = (distance: number, animate: boolean) => {
      const shift = Math.min(MAX_SHIFT, distance * 0.55);
      scroller.style.transition =
        animate && !reduceMotion
          ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease'
          : 'none';
      scroller.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
      scroller.style.opacity = shift ? String(Math.max(0.45, 1 - shift / 180)) : '';
    };
    const reset = () => {
      touchId = null;
      pullFrom = null;
      pull = 0;
      ignored = false;
    };

    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      const inField =
        event.target instanceof Element && event.target.closest('textarea, input, select');
      if (event.touches.length !== 1 || !touch || inField) {
        if (pull) paint(0, true);
        reset();
        return;
      }
      reset();
      touchId = touch.identifier;
      startX = touch.clientX;
      startY = lastY = touch.clientY;
    };

    const move = (event: TouchEvent) => {
      if (touchId === null || ignored) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.identifier !== touchId) {
        if (pull) paint(0, true);
        reset();
        return;
      }
      const y = touch.clientY;
      if (pullFrom === null) {
        const dx = Math.abs(touch.clientX - startX);
        if (dx > 10 && dx > Math.abs(y - startY) * 1.2) {
          ignored = true; // 横向为主，交给别的手势
          return;
        }
        if (y > lastY && scroller.scrollTop <= 0) pullFrom = lastY;
      }
      lastY = y;
      if (pullFrom === null) return;
      const distance = y - pullFrom;
      if (distance <= 0) {
        // 往回推：放开，恢复正常滚动
        pullFrom = null;
        pull = 0;
        paint(0, false);
        return;
      }
      if (event.cancelable) event.preventDefault();
      pull = distance;
      paint(distance, false);
    };

    const end = () => {
      if (touchId === null) return;
      const shouldClose = pull >= CLOSE_DISTANCE;
      const pulled = pull > 0;
      reset();
      if (shouldClose) onCloseRef.current();
      else if (pulled) paint(0, true);
    };

    scroller.addEventListener('touchstart', start, { passive: true });
    scroller.addEventListener('touchmove', move, { passive: false });
    scroller.addEventListener('touchend', end);
    scroller.addEventListener('touchcancel', end);
    return () => {
      scroller.removeEventListener('touchstart', start);
      scroller.removeEventListener('touchmove', move);
      scroller.removeEventListener('touchend', end);
      scroller.removeEventListener('touchcancel', end);
      scroller.style.transition = '';
      scroller.style.transform = '';
      scroller.style.opacity = '';
    };
  }, [scroller]);
}
