'use client';

import { BottomNav, isBottomNavHidden } from '@/components/nav/bottom-nav';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { suspendTelegramVerticalSwipes } from '@/lib/telegram';
import { DramaCommentsProvider } from '@/components/drama/drama-comments-context';
import { useDramaLibraryStore } from '@/stores/drama-library-store';
import { useRouteQueryIsolation } from '@/lib/api/route-query-isolation';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useRouteQueryIsolation(pathname);
  const controlsVisible = useDramaLibraryStore((state) => state.playbackControlsVisible);
  const isDramaPlayback = pathname === '/' || /^\/dramas\/[^/]+/.test(pathname ?? '');
  // 路由级持有：换剧和弹出面板都不能暂时把下滑交回 Telegram。
  useEffect(() => {
    if (!isDramaPlayback) return;
    const restore = suspendTelegramVerticalSwipes();
    return () => {
      restore();
      useDramaLibraryStore.getState().setPlaybackControlsVisible(true);
    };
  }, [isDramaPlayback]);
  const hideBottomNav = isBottomNavHidden(pathname, controlsVisible);

  return (
    <>
      {/* 导航与内容共用安全区高度，隐藏时一同释放，避免空白或遮住末尾内容。 */}
      <div data-main-content className={hideBottomNav ? undefined : 'pb-[var(--app-nav-space)]'}>
        {isDramaPlayback ? <DramaCommentsProvider>{children}</DramaCommentsProvider> : children}
      </div>
      <BottomNav />
    </>
  );
}
