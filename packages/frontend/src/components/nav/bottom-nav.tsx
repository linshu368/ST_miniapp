'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Sparkles, User } from 'lucide-react';

import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: '大厅', Icon: Home },
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
        className="pointer-events-auto flex w-full max-w-[320px] items-center justify-around rounded-[2rem] border border-white/10 bg-[#130d26]/85 px-2 py-2 text-white shadow-[0_12px_36px_rgba(0,0,0,0.6)] backdrop-blur-xl"
      >
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              className={cn(
                'group flex flex-col items-center justify-center gap-1 rounded-full px-2 py-0.5 transition-all duration-300',
                active ? 'text-primary' : 'text-white/50 hover:text-white/80'
              )}
            >
              <span
                className={cn(
                  'flex h-8 w-14 items-center justify-center rounded-full transition-all duration-300',
                  active && 'bg-primary/20 shadow-[0_0_16px_hsl(var(--primary)/0.25)]'
                )}
              >
                <Icon
                  size={20}
                  strokeWidth={active ? 2.5 : 2}
                  aria-hidden="true"
                  className={cn('transition-transform duration-300', active && 'scale-110')}
                />
              </span>
              <span
                className={cn(
                  'text-[10px] font-bold leading-none tracking-wide transition-all duration-300',
                  active ? 'scale-100 opacity-100' : 'scale-95 opacity-70 group-hover:opacity-100'
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
