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
        className="pointer-events-auto grid w-full max-w-[326px] grid-cols-3 gap-1 rounded-[1.75rem] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(28,19,49,0.92),rgba(15,10,29,0.94))] p-1.5 text-white shadow-[0_18px_50px_rgba(0,0,0,0.46),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-2xl"
      >
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = href === '/' ? pathname === href : pathname?.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              className={cn(
                'group relative isolate flex h-[58px] min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-[1.3rem] px-2 transition-[color,background-color,box-shadow,transform] duration-300 ease-out active:scale-[0.97]',
                active
                  ? 'text-[#ffd8ce] ring-1 ring-inset ring-white/[0.13] shadow-[0_7px_20px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.11)]'
                  : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'
              )}
            >
              {active ? (
                <>
                  <span
                    aria-hidden
                    className="absolute inset-0 -z-20 bg-[linear-gradient(145deg,rgba(255,255,255,0.095),rgba(239,111,84,0.14)_52%,rgba(184,76,127,0.11))]"
                  />
                  <span
                    aria-hidden
                    className="absolute inset-x-4 bottom-[-12px] -z-10 h-8 rounded-full bg-primary/25 blur-xl"
                  />
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-0 h-px w-10 -translate-x-1/2 bg-gradient-to-r from-transparent via-[#ffd6c8]/65 to-transparent"
                  />
                </>
              ) : null}
              <span
                className={cn(
                  'relative flex h-7 w-10 items-center justify-center rounded-full transition-all duration-300',
                  active ? 'bg-white/[0.07]' : 'group-hover:bg-white/[0.035]'
                )}
              >
                <Icon
                  size={19}
                  strokeWidth={active ? 2.5 : 2}
                  aria-hidden="true"
                  className={cn(
                    'transition-[transform,filter] duration-300',
                    active && 'scale-105 drop-shadow-[0_2px_6px_rgba(255,170,145,0.28)]'
                  )}
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
