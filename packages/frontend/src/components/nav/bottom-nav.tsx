'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

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
import { readRoleplayDiscovery, rememberRoleplayScroll } from '@/lib/roleplay-navigation';

import { BottomNavShell, isCreationRoute } from './bottom-nav-shell';

export { isBottomNavHidden } from './bottom-nav-shell';

const BACKGROUND_PREFETCH_GAP_MS = 800;

const PRIMARY_ROUTES: readonly PrimaryNavigationRoute[] = [
  '/dramas',
  '/chats',
  '/characters',
  '/creation',
  '/profile',
];

function primaryRouteOf(pathname: string | null): PrimaryNavigationRoute | null {
  if (pathname === '/characters' || pathname === '/chats') return pathname;
  if (isCreationRoute(pathname)) return '/creation';
  if (pathname === '/watch' || pathname?.startsWith('/dramas')) return '/dramas';
  if (pathname?.startsWith('/profile')) return '/profile';
  return null;
}

function backgroundPrefetchTargets(
  pathname: string | null,
  routeWarmupOrder: MobilePerformancePolicy['routeWarmupOrder'],
  limit: MobilePerformancePolicy['backgroundRoutePrefetchLimit']
): string[] {
  const current = primaryRouteOf(pathname);
  return PRIMARY_ROUTES.filter((href) => href !== current)
    .map((href, index) => ({ href, index, rank: routeWarmupOrder.indexOf(href) }))
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
  policy: MobilePerformancePolicy,
  router: { prefetch: (href: string) => void }
): void {
  useEffect(() => {
    const targets = backgroundPrefetchTargets(
      pathname,
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
  }, [pathname, policy, router]);
}

export function BottomNav() {
  const pathname = usePathname();
  const performancePolicy = useMobilePerformancePolicy();
  const queryClient = useQueryClient();
  const router = useRouter();
  const currentRoleplayPath = pathname === '/characters' || pathname === '/chats' ? pathname : null;
  const navigationBackgroundAllowed = useNavigationBackgroundAllowed();
  // Touch intent gives almost no lead time. Warm adjacent chunks only after the current
  // destination has painted, and serialize them to avoid recreating the entry burst.
  useBackgroundRoutePrefetch(pathname, performancePolicy, router);

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
      highlighted={pendingHref ?? pathname}
      hasUnread={hasUnread}
      onIntent={(href) => {
        router.prefetch(href);
        prefetchPrimaryRouteData(queryClient, href, performancePolicy.platform);
      }}
      onNavigate={(event, href, current) => {
        if (!current) beginNavigationQuietWindow(href);
        if (currentRoleplayPath) rememberRoleplayScroll(currentRoleplayPath);
        // 已在大厅或对话列表时再点本栏目：回到顶部，不重新进入页面。
        if (current && href === currentRoleplayPath) {
          event.preventDefault();
          if (href === '/characters') clearLobbyReturnSnapshot();
          window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
          rememberRoleplayScroll(href);
        }
        if (!current) setPendingHref(href);
      }}
    />
  );
}
