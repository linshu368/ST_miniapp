'use client';

import { create } from 'zustand';

import { DEFAULT_THEME_ID, THEME_PRESETS, getThemeById } from '@/lib/themes/presets';

// 用户选定的"消息文本主题"——只控 4 轴文本色,不影响 chat 气泡 / 整体色板
// 持久化:localStorage,key = 'st_miniapp_theme_id'

const STORAGE_KEY = 'st_miniapp_theme_id';

interface ThemeState {
  themeId: string;
  hydrate: () => void;
  setThemeId: (id: string) => void;
}

function readStored(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 忽略 quota 满 / 隐私模式
  }
}

function applyToRoot(themeId: string): void {
  if (typeof document === 'undefined') return;
  const palette = getThemeById(themeId).palette;
  const root = document.documentElement;
  root.style.setProperty('--mes-main', palette.main);
  root.style.setProperty('--mes-italics', palette.italics);
  root.style.setProperty('--mes-quote', palette.quote);
  root.style.setProperty('--mes-underline', palette.underline);
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: DEFAULT_THEME_ID,
  hydrate: () => {
    if (typeof window === 'undefined') return;
    const stored = readStored();
    const themeId =
      stored && THEME_PRESETS.some((t) => t.id === stored) ? stored : DEFAULT_THEME_ID;
    set({ themeId });
    applyToRoot(themeId);
  },
  setThemeId: (id) => {
    const valid = THEME_PRESETS.some((t) => t.id === id) ? id : DEFAULT_THEME_ID;
    writeStored(valid);
    set({ themeId: valid });
    applyToRoot(valid);
  },
}));
