'use client';

import { create } from 'zustand';

export type AppearanceMode = 'dark' | 'light';

const STORAGE_KEY = 'st_miniapp_appearance_mode';

interface AppearanceState {
  mode: AppearanceMode;
  hydrate: () => void;
  setMode: (mode: AppearanceMode) => void;
  toggleMode: () => void;
}

function readStored(): AppearanceMode | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(mode: AppearanceMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 忽略隐私模式 / quota 满，本次内存态仍然生效。
  }
}

function applyToRoot(mode: AppearanceMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.classList.toggle('light', mode === 'light');
  root.dataset.appearance = mode;
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  mode: 'dark',
  hydrate: () => {
    const mode = readStored() ?? 'dark';
    set({ mode });
    applyToRoot(mode);
  },
  setMode: (mode) => {
    writeStored(mode);
    set({ mode });
    applyToRoot(mode);
  },
  toggleMode: () => {
    get().setMode(get().mode === 'dark' ? 'light' : 'dark');
  },
}));
