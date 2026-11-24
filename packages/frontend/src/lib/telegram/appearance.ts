import { isTMA, miniApp } from '@telegram-apps/sdk-react';

import type { Appearance } from '@/lib/appearance/chat-background';

/** 与 globals.css 的 --background 一致；Telegram 只收 hex，不能传 CSS 变量。 */
const CHROME: Record<Appearance, `#${string}`> = { night: '#1d181c', day: '#f8f5f7' };

function attempt(paint: () => void): void {
  try {
    paint();
  } catch {
    // 旧客户端缺某一项颜色能力时保留 Telegram 自己的配色，其余项照常设置。
  }
}

export function paintTelegramChrome(appearance: Appearance): void {
  const color = CHROME[appearance];
  attempt(() => {
    if (!isTMA()) return;
    if (!miniApp.isMounted() && miniApp.mountSync.isAvailable()) miniApp.mountSync();
    attempt(() => miniApp.setHeaderColor.ifAvailable(color));
    attempt(() => miniApp.setBackgroundColor.ifAvailable(color));
    attempt(() => miniApp.setBottomBarColor.ifAvailable(color));
  });
}
