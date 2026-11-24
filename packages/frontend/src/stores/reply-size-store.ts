'use client';

import { create } from 'zustand';

const STORAGE_KEY = 'st_miniapp_reply_size';
/** 线上正文就是 16px（富回复「正文」规则），其余各档按它的倍数整体缩放。 */
const BASE_PX = 16;
export const REPLY_SIZES = [14, 16, 18, 20, 23] as const;
export const DEFAULT_REPLY_SIZE_LEVEL = 1;

interface ReplySizeState {
  level: number;
  hydrate: () => void;
  setLevel: (level: number) => void;
}

export function replyScale(level: number): number {
  return (REPLY_SIZES[level] ?? BASE_PX) / BASE_PX;
}

export function readReplySizeLevel(raw: string | null): number {
  const level = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(level) && level >= 0 && level < REPLY_SIZES.length
    ? level
    : DEFAULT_REPLY_SIZE_LEVEL;
}

export const useReplySizeStore = create<ReplySizeState>((set, get) => ({
  level: DEFAULT_REPLY_SIZE_LEVEL,
  hydrate: () => {
    try {
      const level = readReplySizeLevel(window.localStorage.getItem(STORAGE_KEY));
      if (level !== get().level) set({ level });
    } catch {
      // 读不到存储时用默认大小。
    }
  },
  setLevel: (next) => {
    const level = Math.min(REPLY_SIZES.length - 1, Math.max(0, Math.round(next)));
    if (level === get().level) return;
    set({ level });
    try {
      window.localStorage.setItem(STORAGE_KEY, String(level));
    } catch {
      // 写不进去只影响下次打开。
    }
  },
}));
