'use client';

import { useEffect, useRef, useState } from 'react';

import { restoreRoleplayScroll } from '@/lib/roleplay-navigation';

/**
 * 「点开一段 → 聊 → 返回」是对话页最高频的动作。点开时记下所在分组、搜索词、展开的角色和这一行，
 * 返回时原样恢复，并把这一行停到可视区中间闪一下金边（与剧场返回同一手感）。
 * 只存在本次打开的内存里：切到别的底栏再回来不算返回，按页面原有逻辑处理。
 */
export interface ChatsReturn {
  folder: string;
  search: string;
  expanded: string[];
  /** 点开的会话 id（归拢行即最新那段） */
  anchorId: string;
}

let saved: ChatsReturn | null = null;

export function rememberChatsReturn(value: ChatsReturn): void {
  saved = value;
}

/** StrictMode 下初始化会跑两次：用 peek 读、挂载后再 clear。 */
export function peekChatsReturn(): ChatsReturn | null {
  return saved;
}

export function clearChatsReturn(): void {
  saved = null;
}

/** 吸顶页头与底栏之间才算「看得见」；数值宁大勿小，宁可多滚一次也不要停在被遮住的位置。 */
const HEADER_SPACE = 64;
const NAV_FALLBACK = 96;

function navSpace(): number {
  const nav = document.querySelector('nav[aria-label="主导航"]');
  return nav ? window.innerHeight - nav.getBoundingClientRect().top : NAV_FALLBACK;
}

function revealCentered(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const bottomLimit = window.innerHeight - navSpace();
  if (rect.top >= HEADER_SPACE && rect.bottom <= bottomLimit) return;
  const visibleHeight = bottomLimit - HEADER_SPACE;
  window.scrollTo({
    top: window.scrollY + rect.top - HEADER_SPACE - Math.max(0, (visibleHeight - rect.height) / 2),
    behavior: 'auto',
  });
}

/** 不是从聊天返回、或目标行已不在列表里时，沿用原有的按滚动位置恢复。 */
function fallback() {
  restoreRoleplayScroll('/chats');
}

/**
 * 列表就绪后等目标行出现（展开的段落是异步取的，最多等约 1.5 秒），找到就居中并返回它的 id 用于闪金边。
 */
export function useRevealReturn(anchorId: string | null, ready: boolean) {
  const [flashId, setFlashId] = useState<string | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    if (!ready || finished.current) return;
    if (!anchorId) {
      finished.current = true;
      fallback();
      return;
    }
    let frame = 0;
    let tries = 0;
    const seek = () => {
      const element = document.querySelector<HTMLElement>(
        `[data-chat-anchor="${CSS.escape(anchorId)}"]`
      );
      if (element) {
        finished.current = true;
        revealCentered(element);
        setFlashId(anchorId);
        return;
      }
      if (++tries >= 90) {
        finished.current = true;
        fallback();
        return;
      }
      frame = requestAnimationFrame(seek);
    };
    frame = requestAnimationFrame(seek);
    return () => cancelAnimationFrame(frame);
  }, [ready, anchorId]);

  return flashId;
}
