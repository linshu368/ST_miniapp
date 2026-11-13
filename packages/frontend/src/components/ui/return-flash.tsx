'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * 返回列表时标出「刚才看的那一项」：香槟金内描边先完整画出一帧，再延迟淡出。
 * 只动 opacity；父元素需要 relative，圆角由 className 对齐父元素。剧场剧卡与对话行共用。
 */
export function ReturnFlash({ className }: { className?: string }) {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    // 先以不透明画出一帧，下一帧再开始淡出，过渡才会生效。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFaded(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <span
      aria-hidden
      data-return-flash=""
      className={cn(
        'pointer-events-none absolute inset-0 z-10 rounded-xl shadow-[inset_0_0_0_1.5px_#d9b88a] transition-opacity delay-300 duration-1000 ease-out motion-reduce:transition-none',
        faded ? 'opacity-0' : 'opacity-100',
        className
      )}
    />
  );
}
