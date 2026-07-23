'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, MessageCircle, Sparkles, User } from 'lucide-react';

import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: '大厅', Icon: Home },
  { href: '/chats', label: '聊天', Icon: MessageCircle },
  { href: '/create', label: '创作', Icon: Sparkles },
  { href: '/profile', label: '我的', Icon: User },
] as const;

// 深层页面（支付流程、沉浸式输入页）隐藏底部导航，让主内容拿满可视高度
const HIDDEN_PREFIXES = ['/profile/recharge', '/create/wish'];

export function BottomNav() {
  const pathname = usePathname();
  if (pathname && HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 sm:bottom-6"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <nav
        aria-label="主导航"
        className="pointer-events-auto grid w-full max-w-[390px] grid-cols-4 gap-1 rounded-[1.65rem] border border-white/[0.08] bg-[#171027]/92 p-1.5 text-white shadow-[0_14px_38px_rgba(0,0,0,0.38)] backdrop-blur-2xl"
      >
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = href === '/' ? pathname === href : pathname?.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              prefetch={false}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              className={cn(
                'group relative isolate flex h-[58px] min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-[1.3rem] px-2 transition-[color,background-color,box-shadow,transform] duration-300 ease-out active:scale-[0.97]',
                active
                  ? 'bg-white/[0.075] text-[#ffe3dc] ring-1 ring-inset ring-white/[0.09]'
                  : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'
              )}
            >
              {active ? (
                <>
                  <span
                    aria-hidden
                    className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),transparent_72%)]"
                  />
                  <span
                    aria-hidden
                    className="absolute bottom-1.5 left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-[#ef856d]"
                  />
                </>
              ) : null}
              <span
                className={cn(
                  'relative flex h-7 w-10 items-center justify-center transition-colors duration-300',
                  !active && 'group-hover:text-white/80'
                )}
              >
                <Icon
                  size={19}
                  strokeWidth={active ? 2.5 : 2}
                  aria-hidden="true"
                  className={cn('transition-transform duration-300', active && 'scale-105')}
                />
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
