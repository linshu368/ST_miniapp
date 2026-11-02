'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useDramaLibraryStore } from '@/stores/drama-library-store';
import { useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { useSupportUnreadQuery } from '@/lib/api/support';
import { clearLobbyReturnSnapshot } from '@/lib/lobby-return';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { afterEntryBackground } from '@/lib/entry-phase';
import { useMobilePerformancePolicy, type MobilePerformancePolicy } from '@/lib/mobile-performance';
import {
  readRoleplayView,
  rememberRoleplayScroll,
  rememberRoleplayView,
} from '@/lib/roleplay-navigation';

import { BottomNavShell, isCreationRoute } from './bottom-nav-shell';

export { isBottomNavHidden } from './bottom-nav-shell';

const BACKGROUND_PREFETCH_GAP_MS = 800;

function backgroundPrefetchTargets(
  pathname: string | null,
  roleplayHref: '/characters' | '/chats',
  routePriority: MobilePerformancePolicy['routePriority']
): string[] {
  let candidates: string[] = [];
  if (pathname === '/characters' || pathname === '/chats')
    candidates = ['/creation', '/', '/dramas'];
  else if (isCreationRoute(pathname)) candidates = [roleplayHref, '/', '/dramas'];
  else if (pathname === '/') candidates = [roleplayHref, '/dramas'];
  else if (pathname?.startsWith('/dramas')) candidates = ['/', '/profile', roleplayHref];
  else if (pathname?.startsWith('/profile')) candidates = ['/dramas', '/', roleplayHref];

  const kind = (href: string): MobilePerformancePolicy['routePriority'][number] => {
    if (href === '/characters' || href === '/chats') return 'characters';
    if (href === '/') return 'home';
    if (href === '/dramas') return 'dramas';
    return 'other';
  };
  return candidates
    .map((href, index) => ({ href, index, rank: routePriority.indexOf(kind(href)) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, 2)
    .map(({ href }) => href);
}

export function BottomNav() {
  const pathname = usePathname();
  const performancePolicy = useMobilePerformancePolicy();
  const dramaControlsVisible = useDramaLibraryStore((state) => state.playbackControlsVisible);
  const router = useRouter();
  const currentRoleplayPath = pathname === '/characters' || pathname === '/chats' ? pathname : null;
  const [roleplayHref, setRoleplayHref] = useState<'/characters' | '/chats'>('/characters');

  useEffect(() => {
    if (currentRoleplayPath) {
      rememberRoleplayView(currentRoleplayPath);
      setRoleplayHref(currentRoleplayPath);
      return;
    }
    setRoleplayHref(readRoleplayView());
  }, [currentRoleplayPath]);

  useEffect(() => {
    const targets = backgroundPrefetchTargets(
      pathname,
      roleplayHref,
      performancePolicy.routePriority
    );
    if (targets.length === 0) return;

    let cancelled = false;
    let timer: number | undefined;
    let idleHandle: number | undefined;
    let nextIndex = 0;
    const scheduleNext = () => {
      if (cancelled || nextIndex >= targets.length || !canPrefetchInBackground()) return;
      const run = () => {
        idleHandle = undefined;
        if (cancelled || !canPrefetchInBackground()) return;
        router.prefetch(targets[nextIndex]!);
        nextIndex += 1;
        if (nextIndex < targets.length) {
          timer = window.setTimeout(scheduleNext, BACKGROUND_PREFETCH_GAP_MS);
        }
      };
      if (typeof window.requestIdleCallback === 'function') {
        idleHandle = window.requestIdleCallback(run, { timeout: 1500 });
      } else {
        timer = window.setTimeout(run, 250);
      }
    };

    // Touch intent gives almost no lead time. Warm only adjacent destinations after P0 work,
    // and serialize them so route chunks do not recreate the original cold-start burst.
    void afterEntryBackground().then(scheduleNext);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (idleHandle !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle);
      }
    };
  }, [pathname, performancePolicy, roleplayHref, router]);

  // 未读属于「我的」：只在 profile 拉取/轮询。大厅、影像、聊天都不提前打，缓存仍可画红点。
  const onProfileTab = Boolean(pathname?.startsWith('/profile'));
  const unread = useNotificationUnreadCountQuery({ enabled: onProfileTab });
  const supportUnread = useSupportUnreadQuery({ enabled: onProfileTab });
  // 「我的」页里公告和客服回复各有各的红点，导航上只汇总成一个。
  const hasUnread = (unread.data?.total ?? 0) > 0 || supportUnread.data?.has_unread === true;

  // 点击后立刻反馈目标模块，路由提交后再以真实位置为准。
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);
  // 导航被中断时 pathname 不会变，兜底把高亮还给真实路由，避免停在错误的 tab 上。
  useEffect(() => {
    if (!pendingHref) return;
    const timer = window.setTimeout(() => setPendingHref(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingHref]);

  return (
    <BottomNavShell
      pathname={pathname}
      controlsVisible={dramaControlsVisible}
      highlighted={pendingHref ?? pathname}
      roleplayHref={currentRoleplayPath ?? roleplayHref}
      hasUnread={hasUnread}
      onIntent={(href) => router.prefetch(href)}
      onNavigate={(event, targetHref, href, current) => {
        if (currentRoleplayPath) rememberRoleplayScroll(currentRoleplayPath);
        if (href === '/characters') {
          rememberRoleplayView(targetHref === '/chats' ? '/chats' : '/characters');
          if (currentRoleplayPath) {
            event.preventDefault();
            if (currentRoleplayPath === '/characters') clearLobbyReturnSnapshot();
            window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            rememberRoleplayScroll(currentRoleplayPath);
          }
        }
        if (!current) setPendingHref(targetHref);
      }}
    />
  );
}
