'use client';

import { create } from 'zustand';

import { getTelegramDefaultDisplayName, getTelegramPhotoUrl } from '@/lib/telegram/user';

// 用户在 chat 内的"显示名"——也就是 markdown 管线 {{user}} 宏要替换成的字符串。
// 优先级:用户在 profile 页的自定义 > Telegram first_name/username > '你'
// 持久化:localStorage,key = 'st_miniapp_display_name'

const STORAGE_KEY = 'st_miniapp_display_name';

interface UserProfileState {
  /** 当前生效的显示名(已结合 localStorage 覆盖 + telegram 默认) */
  displayName: string;
  /** Telegram 原始头像 URL。用户没有头像或客户端不返回时为空。 */
  photoUrl?: string;
  /** 是否用户手动设置过(true=覆盖了默认,false=跟随 telegram 默认) */
  hasCustomName: boolean;
  /** 客户端首次进入页面时调用,从 telegram + localStorage 恢复状态 */
  hydrate: () => void;
  /** 用户在 profile 页改名时调用。空字符串 → 清除自定义,回退到 telegram 默认 */
  setDisplayName: (next: string) => void;
  /** 服务端 settings 返回后调用。null 表示继续使用本地/Telegram fallback */
  applyServerDisplayName: (next: string | null) => void;
}

function readOverride(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeOverride(value: string | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (value && value.trim().length > 0) {
      window.localStorage.setItem(STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 隐私模式 / quota 满 等场景静默失败,内存态仍然生效
  }
}

export const useUserProfileStore = create<UserProfileState>((set) => ({
  displayName: '你',
  photoUrl: undefined,
  hasCustomName: false,
  hydrate: () => {
    if (typeof window === 'undefined') return;
    const override = readOverride();
    const fallback = getTelegramDefaultDisplayName();
    set({
      displayName: override ?? fallback,
      photoUrl: getTelegramPhotoUrl(),
      hasCustomName: !!override,
    });
  },
  setDisplayName: (next) => {
    const trimmed = next.trim();
    if (trimmed.length === 0) {
      // 清除自定义,回到 telegram 默认
      writeOverride(undefined);
      set({ displayName: getTelegramDefaultDisplayName(), hasCustomName: false });
    } else {
      writeOverride(trimmed);
      set({ displayName: trimmed, hasCustomName: true });
    }
  },
  applyServerDisplayName: (next) => {
    const normalized = next?.trim();
    if (normalized) {
      writeOverride(normalized);
      set({ displayName: normalized, hasCustomName: true });
      return;
    }

    const fallback = readOverride() ?? getTelegramDefaultDisplayName();
    set({ displayName: fallback, hasCustomName: !!readOverride() });
  },
}));
