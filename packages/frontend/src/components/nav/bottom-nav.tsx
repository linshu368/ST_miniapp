'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Home, Sparkles, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAfterFirstScreen } from '@/lib/after-first-screen';
import { prefetchImagePlazaFeed } from '@/lib/api/image-plaza';
import { useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { useSupportUnreadQuery } from '@/lib/api/support';
import { clearLobbyReturnSnapshot } from '@/lib/lobby-return';
import {
  readRoleplayView,
  rememberRoleplayScroll,
  rememberRoleplayView,
} from '@/lib/roleplay-navigation';

const NAV_ITEMS = [
  { href: '/', label: '角色', Icon: Home },
  { href: '/create', label: '影像', Icon: Sparkles },
  { href: '/profile', label: '我的', Icon: User },
] as const;

// 深层页面（支付流程、沉浸式输入页、消息与客服会话）隐藏底部导航，让主内容拿满可视高度
const HIDDEN_PREFIXES = [
  '/profile/recharge',
  '/profile/messages',
  '/profile/support',
  '/create/studio',
  '/vip',
];

export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const currentRoleplayPath = pathname === '/' || pathname === '/chats' ? pathname : null;
  const [roleplayHref, setRoleplayHref] = useState<'/' | '/chats'>('/');

  useEffect(() => {
    if (currentRoleplayPath) {
      rememberRoleplayView(currentRoleplayPath);
      setRoleplayHref(currentRoleplayPath);
      return;
    }
    setRoleplayHref(readRoleplayView());
  }, [currentRoleplayPath]);
  // 红点不在首屏关键路径上；冷启动先让给首屏，之后照常轮询。/profile 页自己的读者不受影响。
  const firstScreenDone = useAfterFirstScreen();
  const unread = useNotificationUnreadCountQuery({ enabled: firstScreenDone });
  const supportUnread = useSupportUnreadQuery({ enabled: firstScreenDone });
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

  // 在空闲时预取主模块，避免争抢当前页面的加载带宽。
  useEffect(() => {
    const prefetchAll = () => {
      for (const item of NAV_ITEMS) router.prefetch(item.href);
    };
    const idle = window.requestIdleCallback;
    if (typeof idle === 'function') {
      const handle = idle(prefetchAll, { timeout: 4000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(prefetchAll, 2000);
    return () => window.clearTimeout(timer);
  }, [router]);

  // 图片广场首页数据在首屏结束后预取：点进「创作」时直接有内容可画，而不是先骨架再等 feed。
  // 导航栏随 (main) 布局常驻，这个 effect 每个会话只跑一次。
  useEffect(() => {
    if (!firstScreenDone) return;
    void prefetchImagePlazaFeed(queryClient);
  }, [firstScreenDone, queryClient]);

  if (pathname && HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }

  const highlighted = pendingHref ?? pathname;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 sm:bottom-6"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* 不用 backdrop-blur：导航悬浮在持续滚动、带流光动画的列表上方，模糊要每帧重采样背后内容，
          弱机 WebView 上会占满合成线程（大厅卡片去模糊同理），点按响应也会被拖慢。 */}
      <nav
        aria-label="主导航"
        className="pointer-events-auto grid w-full max-w-[390px] grid-cols-3 gap-1 rounded-[1.65rem] border border-border bg-card/[0.97] p-1.5 text-foreground shadow-[0_14px_38px_rgba(0,0,0,0.38)]"
      >
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const targetHref = href === '/' ? (currentRoleplayPath ?? roleplayHref) : href;
          const active =
            href === '/'
              ? highlighted === '/' || highlighted === '/chats'
              : highlighted?.startsWith(href);
          const current = href === '/' ? Boolean(currentRoleplayPath) : pathname?.startsWith(href);
          return (
            <Link
              key={href}
              href={targetHref}
              scroll={href === '/' ? false : undefined}
              onClick={(event) => {
                if (currentRoleplayPath) rememberRoleplayScroll(currentRoleplayPath);
                if (href === '/') {
                  rememberRoleplayView(targetHref === '/chats' ? '/chats' : '/');
                  if (currentRoleplayPath) {
                    event.preventDefault();
                    if (currentRoleplayPath === '/') clearLobbyReturnSnapshot();
                    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
                    rememberRoleplayScroll(currentRoleplayPath);
                  }
                }
                setPendingHref(targetHref);
              }}
              aria-current={current ? 'page' : undefined}
              aria-label={label}
              className={cn(
                'group relative isolate flex h-[58px] min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-[1.3rem] px-2 transition-[color,background-color,box-shadow,transform] duration-300 ease-out active:scale-[0.97]',
                active
                  ? 'bg-foreground/[0.06] text-primary ring-1 ring-inset ring-foreground/[0.08]'
                  : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/75'
              )}
            >
              {active ? (
                <>
                  <span
                    aria-hidden
                    className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,hsl(var(--foreground)/0.035),transparent_72%)]"
                  />
                  <span
                    aria-hidden
                    className="absolute bottom-1.5 left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-primary"
                  />
                </>
              ) : null}
              <span
                className={cn(
                  'relative flex h-7 w-10 items-center justify-center transition-colors duration-300',
                  !active && 'group-hover:text-foreground/80'
                )}
              >
                <Icon
                  size={19}
                  strokeWidth={active ? 2.5 : 2}
                  aria-hidden="true"
                  className={cn('transition-transform duration-300', active && 'scale-105')}
                />
                {href === '/profile' && hasUnread ? (
                  <span
                    role="status"
                    aria-label="有未读消息"
                    className="absolute right-1.5 top-0.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-card"
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  'text-[10px] font-semibold leading-none tracking-[0.08em] transition-all duration-300',
                  active ? 'opacity-100' : 'opacity-75 group-hover:opacity-100'
                )}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
