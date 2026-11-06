'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useDramaLibraryStore } from '@/stores/drama-library-store';
import { useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { useSupportUnreadQuery } from '@/lib/api/support';
import { prefetchCharactersQuery } from '@/lib/api/characters';
import { prefetchFavoritesQuery } from '@/lib/api/favorites';
import { prefetchWalletBalanceQuery } from '@/lib/api/payment';
import { clearLobbyReturnSnapshot } from '@/lib/lobby-return';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { afterEntryBackground } from '@/lib/entry-phase';
import {
  afterNavigationQuietWindow,
  beginNavigationQuietWindow,
  isNavigationBackgroundAllowed,
  useNavigationBackgroundAllowed,
} from '@/lib/navigation-quiet-window';
import {
  useMobilePerformancePolicy,
  type MobilePerformancePolicy,
  type PrimaryNavigationRoute,
} from '@/lib/mobile-performance';
import {
  readRoleplayDiscovery,
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
  routeWarmupOrder: MobilePerformancePolicy['routeWarmupOrder'],
  limit: MobilePerformancePolicy['backgroundRoutePrefetchLimit']
): string[] {
  const candidates = [roleplayHref, '/creation', '/watch', '/dramas', '/profile'];
  const normalized = (href: string): PrimaryNavigationRoute =>
    href === '/chats' ? '/characters' : (href as PrimaryNavigationRoute);
  const current =
    pathname === '/characters' || pathname === '/chats'
      ? '/characters'
      : isCreationRoute(pathname)
        ? '/creation'
        : pathname === '/watch'
          ? '/watch'
          : pathname?.startsWith('/dramas')
            ? '/dramas'
            : pathname?.startsWith('/profile')
              ? '/profile'
              : null;
  return candidates
    .filter((href) => normalized(href) !== current)
    .map((href, index) => ({ href, index, rank: routeWarmupOrder.indexOf(normalized(href)) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, limit)
    .map(({ href }) => href);
}

function prefetchPrimaryRouteData(
  queryClient: QueryClient,
  href: string,
  platform: MobilePerformancePolicy['platform']
): void {
  // Android touchstart is too close to click to warm secondary data without competing
  // with the route chunk. Characters remains because its list gates content-ready.
  if (platform === 'android' && href !== '/characters') return;
  if (href === '/characters') {
    void prefetchCharactersQuery(queryClient, readRoleplayDiscovery('latest').sort);
  } else if (href === '/creation') {
    void prefetchFavoritesQuery(queryClient);
  } else if (href === '/profile') {
    void prefetchWalletBalanceQuery(queryClient);
  }
}

function useBackgroundRoutePrefetch(
  pathname: string | null,
  roleplayHref: '/characters' | '/chats',
  policy: MobilePerformancePolicy,
  router: { prefetch: (href: string) => void }
): void {
  useEffect(() => {
    const targets = backgroundPrefetchTargets(
      pathname,
      roleplayHref,
      policy.routeWarmupOrder,
      policy.backgroundRoutePrefetchLimit
    );
    if (targets.length === 0) return;

    let cancelled = false;
    let timer: number | undefined;
    let idleHandle: number | undefined;
    let nextIndex = 0;
    const scheduleNext = () => {
      if (
        cancelled ||
        nextIndex >= targets.length ||
        !isNavigationBackgroundAllowed() ||
        !canPrefetchInBackground()
      )
        return;
      const run = () => {
        idleHandle = undefined;
        if (cancelled || !isNavigationBackgroundAllowed() || !canPrefetchInBackground()) return;
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

    void afterEntryBackground().then(afterNavigationQuietWindow).then(scheduleNext);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (idleHandle !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle);
      }
    };
  }, [pathname, policy, roleplayHref, router]);
}

export function BottomNav() {
  const pathname = usePathname();
  const performancePolicy = useMobilePerformancePolicy();
  const queryClient = useQueryClient();
  const dramaControlsVisible = useDramaLibraryStore((state) => state.playbackControlsVisible);
  const router = useRouter();
  const currentRoleplayPath = pathname === '/characters' || pathname === '/chats' ? pathname : null;
  const [roleplayHref, setRoleplayHref] = useState<'/characters' | '/chats'>('/characters');
  const navigationBackgroundAllowed = useNavigationBackgroundAllowed();

  useEffect(() => {
    if (currentRoleplayPath) {
      rememberRoleplayView(currentRoleplayPath);
      setRoleplayHref(currentRoleplayPath);
      return;
    }
    setRoleplayHref(readRoleplayView());
  }, [currentRoleplayPath]);
  // Touch intent gives almost no lead time. Warm adjacent chunks only after the current
  // destination has painted, and serialize them to avoid recreating the entry burst.
  useBackgroundRoutePrefetch(pathname, roleplayHref, performancePolicy, router);

  // 未读属于「我的」：只在 profile 拉取/轮询。大厅、影像、聊天都不提前打，缓存仍可画红点。
  const onProfileTab = Boolean(pathname?.startsWith('/profile'));
  const unread = useNotificationUnreadCountQuery({
    enabled: onProfileTab && navigationBackgroundAllowed,
  });
  const supportUnread = useSupportUnreadQuery({
    enabled: onProfileTab && navigationBackgroundAllowed,
  });
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
      onIntent={(href) => {
        router.prefetch(href);
        prefetchPrimaryRouteData(queryClient, href, performancePolicy.platform);
      }}
      onNavigate={(event, targetHref, href, current) => {
        if (!current) beginNavigationQuietWindow(targetHref);
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
