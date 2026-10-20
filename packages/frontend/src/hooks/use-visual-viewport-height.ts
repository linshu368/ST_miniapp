'use client';

import { useEffect, useState } from 'react';

/**
 * 跟随可视视口高度。
 *
 * iOS 弹出键盘时不会改变 100dvh，而是把整页往上推来露出焦点元素，
 * 于是 sticky 的聊天顶栏被推出屏幕外，用户在打字时看不到返回和角色名。
 * visualViewport 是唯一能反映键盘占位的量：拿它当容器高度，容器自己就收缩到
 * 键盘上方，页面不再需要被推动；再把已经发生的那次推动滚回原点，顶栏就留住了。
 *
 * 返回 null 表示还没水合或浏览器不支持，此时交给 CSS 的 100dvh 兜底。
 */
export function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const sync = () => {
      setHeight(viewport.height);
      // 聊天页整页不滚动（消息区是内部滚动），body 上的 scrollY 只可能来自键盘那次推移
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
    };
  }, []);

  return height;
}
