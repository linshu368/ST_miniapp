'use client';

import { useEffect, useState } from 'react';

/**
 * 无操作一定时间后进入"暗化"状态。
 *
 * 服务场景：夜间沉浸对话时，用户可能只是在看消息、不操作。
 * 让顶栏、底栏、Composer 等 chrome 淡出到 40%，把视觉让给对话本身。
 * 任何触屏 / 指针移动 / 按键 / 滚动都会恢复。
 *
 * @param delayMs 无操作多久后进入 dim 状态，默认 30s
 * @returns isDim：true 表示应当暗化 chrome
 */
export function useIdleDim(delayMs: number = 30_000): boolean {
  const [isDim, setIsDim] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
      setIsDim(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setIsDim(true), delayMs);
    };

    // 初次挂载时就开始计时
    reset();

    const events: Array<keyof WindowEventMap> = [
      'touchstart',
      'pointerdown',
      'keydown',
      'scroll',
      'wheel',
    ];
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }));

    return () => {
      if (timer) clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, reset));
    };
  }, [delayMs]);

  return isDim;
}
