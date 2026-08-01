'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Home, MessageCircle, Sparkles, User } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { useSupportUnreadQuery } from '@/lib/api/support';

const NAV_ITEMS = [
  { href: '/', label: '大厅', Icon: Home },
  { href: '/chats', label: '聊天', Icon: MessageCircle },
  { href: '/create', label: '创作', Icon: Sparkles },
  { href: '/profile', label: '我的', Icon: User },
] as const;

// 深层页面（支付流程、沉浸式输入页、消息与客服会话）隐藏底部导航，让主内容拿满可视高度
const HIDDEN_PREFIXES = [
  '/profile/recharge',
  '/profile/messages',
  '/profile/support',
  '/create/wish',
];

export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const unread = useNotificationUnreadCountQuery();
  const supportUnread = useSupportUnreadQuery();
  // 「我的」页里公告和客服回复各有各的红点，导航上只汇总成一个。
  const hasUnread = (unread.data?.total ?? 0) > 0 || supportUnread.data?.has_unread === true;

  // 点击后立刻把高亮挪过去，不等路由提交；否则 ST iframe 占着主线程时按钮会看着像没反应。
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

  // 四个主路由改成预取，但排到空闲帧，避免和 ST 冷启动抢带宽。
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

  if (pathname && HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }

  const highlighted = pendingHref ?? pathname;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 sm:bottom-6"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <nav
        aria-label="主导航"
        className="pointer-events-auto grid w-full max-w-[390px] grid-cols-4 gap-1 rounded-[1.65rem] border border-border bg-card/92 p-1.5 text-foreground shadow-[0_14px_38px_rgba(0,0,0,0.38)] backdrop-blur-2xl"
      >
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = href === '/' ? highlighted === href : highlighted?.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={() => setPendingHref(href)}
              aria-current={pathname === href ? 'page' : undefined}
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
