'use client';

import { create } from 'zustand';

// 消息字号倍率——独立于主题,仅控制 chat 消息文本大小
// 三档参考微信 / Telegram 的"小 / 标准 / 大",实测在手机上够用
// 持久化:localStorage,key = 'st_miniapp_font_scale'

const STORAGE_KEY = 'st_miniapp_font_scale';

export type FontScale = 'small' | 'normal' | 'large';

export const FONT_SCALE_OPTIONS: Array<{ id: FontScale; label: string; multiplier: number }> = [
  { id: 'small', label: '小', multiplier: 0.92 },
  { id: 'normal', label: '标准', multiplier: 1 },
  { id: 'large', label: '大', multiplier: 1.12 },
];

const DEFAULT_SCALE: FontScale = 'normal';

interface FontScaleState {
  scale: FontScale;
  hydrate: () => void;
  setScale: (scale: FontScale) => void;
}

function isFontScale(v: unknown): v is FontScale {
  return v === 'small' || v === 'normal' || v === 'large';
}

function readStored(): FontScale | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isFontScale(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(scale: FontScale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, scale);
  } catch {
    // ignore
  }
}

function applyToRoot(scale: FontScale): void {
  if (typeof document === 'undefined') return;
  const opt = FONT_SCALE_OPTIONS.find((o) => o.id === scale);
  if (!opt) return;
  document.documentElement.style.setProperty('--mes-font-scale', String(opt.multiplier));
}

export const useFontScaleStore = create<FontScaleState>((set) => ({
  scale: DEFAULT_SCALE,
  hydrate: () => {
    if (typeof window === 'undefined') return;
    const stored = readStored() ?? DEFAULT_SCALE;
    set({ scale: stored });
    applyToRoot(stored);
  },
  setScale: (scale) => {
    writeStored(scale);
    set({ scale });
    applyToRoot(scale);
  },
}));
