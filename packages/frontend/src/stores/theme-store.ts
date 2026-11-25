'use client';

import { create } from 'zustand';

import type { Appearance } from '@/lib/appearance/chat-background';
import { readStoredTheme, THEME_KEY } from '@/lib/appearance/theme';
import { sendSentryLog } from '@/lib/sentry/client';

interface ThemeState {
  theme: Appearance;
  /** 用户切换过才接管 Telegram 的顶栏和底栏颜色；没切过的人保持原样。 */
  chosen: boolean;
  toggle: () => void;
}

const stored = readStoredTheme();

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: stored ?? 'night',
  chosen: stored !== null,
  toggle: () => {
    const theme: Appearance = get().theme === 'night' ? 'day' : 'night';
    let saved = true;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 写不进去时本次仍生效，只是下次打开回到夜间。
      saved = false;
    }
    set({ theme, chosen: true });
    sendSentryLog('info', 'appearance.theme_changed', { theme, saved });
  },
}));
