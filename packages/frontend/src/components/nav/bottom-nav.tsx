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

// 深层页面（支付流程、充值详情）隐藏底部导航，让主内容拿满可视高度
const HIDDEN_PREFIXES = ['/profile/recharge'];

export function BottomNav() {
  const pathname = usePathname();
  if (pathname && HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null;
  }

  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 bg-gradient-to-t from-[#080014] via-[#080014]/92 to-[#080014]/0 pt-7 text-white"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex w-full max-w-md items-end justify-around gap-1 px-3 pb-2 pt-1 sm:max-w-xl">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              className={cn(
                'group flex min-w-0 flex-1 flex-col items-center gap-0.5 px-3 py-1.5 transition-all duration-200 sm:px-8',
                active ? 'text-primary' : 'text-white/38 hover:text-white/75'
              )}
            >
              <Icon
                size={24}
                strokeWidth={active ? 2 : 1.5}
                aria-hidden="true"
                className={cn(
                  'transition-transform duration-200',
                  active && 'scale-[1.08] drop-shadow-[0_0_10px_hsl(var(--primary)/0.45)]'
                )}
              />
              <span
                className={cn(
                  'text-[10px] font-medium transition-opacity duration-200',
                  active ? 'opacity-100' : 'opacity-70 group-hover:opacity-100'
                )}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
