'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Clapperboard, MessagesSquare, Play, Sparkles, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useDramaLibraryStore } from '@/stores/drama-library-store';
import { useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { useSupportUnreadQuery } from '@/lib/api/support';
import { clearLobbyReturnSnapshot } from '@/lib/lobby-return';
import {
  readRoleplayView,
  rememberRoleplayScroll,
  rememberRoleplayView,
} from '@/lib/roleplay-navigation';

const NAV_ITEMS = [
  { href: '/characters', label: '角色', Icon: MessagesSquare },
  { href: '/dramas', label: 'AI短剧', Icon: Clapperboard },
  { href: '/', label: '首页', Icon: Play },
  { href: '/create', label: '生成', Icon: Sparkles },
  { href: '/profile', label: '我的', Icon: User },
] as const;

const HEAVY_ROUTE_HREFS = new Set<string>(['/', '/dramas', '/create']);

type NavigatorWithConnection = Navigator & {
  connection?: { saveData?: boolean; effectiveType?: string };
};

function canPrefetchHeavyRoute(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  const connection = (navigator as NavigatorWithConnection).connection;
  return (
    navigator.onLine !== false &&
    connection?.saveData !== true &&
    connection?.effectiveType !== 'slow-2g' &&
    connection?.effectiveType !== '2g'
  );
}

// 深层页面（支付流程、沉浸式输入页、消息与客服会话）隐藏底部导航，让主内容拿满可视高度
const HIDDEN_PREFIXES = [
  '/profile/recharge',
  '/profile/messages',
  '/profile/support',
  '/create/studio',
  '/vip',
];

export function isBottomNavHidden(pathname: string | null, controlsVisible = true) {
  return Boolean(
    pathname &&
    ((pathname === '/' && !controlsVisible) ||
      HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
      /^\/dramas\/[^/]+/.test(pathname))
  );
}

export function BottomNav() {
  const pathname = usePathname();
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

/** 启动时只复用导航展示，不读取身份、storage 或挂业务 query。 */
export function BottomNavShell({
  pathname,
  controlsVisible = true,
  highlighted = pathname,
  roleplayHref = '/characters',
  hasUnread = false,
  onIntent,
  onNavigate,
}: {
  pathname: string;
  controlsVisible?: boolean;
  highlighted?: string | null;
  roleplayHref?: '/characters' | '/chats';
  hasUnread?: boolean;
  onIntent?: (href: string) => void;
  onNavigate?: (
    event: React.MouseEvent<HTMLAnchorElement>,
    targetHref: string,
    href: string,
    current: boolean
  ) => void;
}) {
  if (isBottomNavHidden(pathname, controlsVisible)) return null;
  const currentRoleplayPath = pathname === '/characters' || pathname === '/chats' ? pathname : null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center bg-[#19171a]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* 不用 backdrop-blur：导航悬浮在持续滚动、带流光动画的列表上方，模糊要每帧重采样背后内容，
          弱机 WebView 上会占满合成线程（大厅卡片去模糊同理），点按响应也会被拖慢。 */}
      <nav
        aria-label="主导航"
        className="pointer-events-auto grid h-[var(--app-nav-height)] w-full max-w-lg grid-cols-5 items-center gap-1 border-t border-white/[0.055] px-2 text-[#eee7e2]"
      >
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const targetHref = href === '/characters' ? (currentRoleplayPath ?? roleplayHref) : href;
          const active =
            href === '/characters'
              ? highlighted === '/characters' || highlighted === '/chats'
              : href === '/'
                ? highlighted === '/'
                : highlighted?.startsWith(href);
          const current =
            href === '/characters'
              ? Boolean(currentRoleplayPath)
              : href === '/'
                ? pathname === '/'
                : pathname?.startsWith(href);
          const isHeavyRoute = HEAVY_ROUTE_HREFS.has(href);
          const prefetchOnIntent = () => {
            if (!current && (!isHeavyRoute || canPrefetchHeavyRoute())) {
              onIntent?.(targetHref);
            }
          };
          return (
            <Link
              key={href}
              href={targetHref}
              prefetch={false}
              scroll={href === '/characters' ? false : undefined}
              // 底栏常驻；关闭视口自动预取，只在明确 hover/focus/touch 意图时拉目标路由。
              onMouseEnter={prefetchOnIntent}
              onFocus={prefetchOnIntent}
              onTouchStart={prefetchOnIntent}
              onClick={(event) => onNavigate?.(event, targetHref, href, current)}
              aria-current={current ? 'page' : undefined}
              aria-label={label}
              className={cn(
                'group relative flex h-[58px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 transition-[color,background-color,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#d7b4bf] motion-reduce:transition-none',
                href === '/'
                  ? 'px-0'
                  : active
                    ? 'text-[#f0e3e6]'
                    : 'text-[#9f969d] hover:text-[#eee7e2] active:bg-white/[0.04]'
              )}
            >
              {href === '/' ? (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 44 44"
                  fill="none"
                  className={cn(
                    'h-[38px] w-[38px] transition-colors duration-150 motion-reduce:transition-none',
                    active ? 'text-[#f3e6e9]' : 'text-[#c9adb8]'
                  )}
                >
                  <path
                    d="M10.5 9.6C8.3 8.4 5.6 10 5.6 12.5v19c0 2.5 2.7 4.1 4.9 2.9l7-4V13.6l-7-4Z"
                    fill={active ? '#b78599' : '#745460'}
                  />
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M17.6 6.9c-2.7-1.6-6.1.4-6.1 3.5v23.2c0 3.1 3.4 5.1 6.1 3.5l20.1-11.6c2.7-1.6 2.7-5.4 0-7L17.6 6.9Zm1.1 8.5c-.5-.3-1.2.1-1.2.7v11.8c0 .6.7 1 1.2.7l10.2-5.9c.5-.3.5-1.1 0-1.4l-10.2-5.9Z"
                    fill="currentColor"
                  />
                  <path
                    d="M17.6 6.9 37.7 18.5"
                    stroke={active ? '#fff7f4' : '#e7cfd6'}
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <>
                  <span
                    className={cn(
                      'relative flex h-7 w-11 items-center justify-center rounded-full transition-colors duration-150 motion-reduce:transition-none',
                      active ? 'bg-[#d7b4bf]/[0.08]' : 'bg-transparent'
                    )}
                  >
                    <Icon size={21} strokeWidth={active ? 1.9 : 1.65} aria-hidden="true" />
                    {href === '/profile' && hasUnread ? (
                      <span
                        role="status"
                        aria-label="有未读消息"
                        className="absolute right-1.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[#d9919b] ring-2 ring-[#19171a]"
                      />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      'whitespace-nowrap text-[11px] leading-none',
                      active ? 'font-semibold' : 'font-medium'
                    )}
                  >
                    {label}
                  </span>
                </>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
