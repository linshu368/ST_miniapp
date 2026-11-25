'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect } from 'react';

import { effectiveAppearance, paintAppearance } from '@/lib/appearance/theme';
import { paintTelegramChrome } from '@/lib/telegram/appearance';
import { useThemeStore } from '@/stores/theme-store';

// 服务端没有布局阶段；浏览器里必须赶在绘制前换，进出剧场才不会闪。
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** 昼夜落到页面上的唯一出口：切换、进出剧场都在这里。 */
export function AppearanceSync({ telegramReady }: { telegramReady: boolean }) {
  const pathname = usePathname();
  const theme = useThemeStore((state) => state.theme);
  const chosen = useThemeStore((state) => state.chosen);
  const appearance = effectiveAppearance(theme, pathname);
  useBeforePaint(() => paintAppearance(appearance), [appearance]);
  useEffect(() => {
    if (telegramReady && chosen) paintTelegramChrome(appearance);
  }, [telegramReady, chosen, appearance]);
  return null;
}
