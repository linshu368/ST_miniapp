'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { PenLine } from 'lucide-react';

import { rememberRoleplayScroll, rememberRoleplayView } from '@/lib/roleplay-navigation';
import { cn } from '@/lib/utils';

const VIEWS = [
  { key: 'discover', href: '/characters', label: '发现' },
  { key: 'conversations', href: '/chats', label: '对话' },
] as const;

export function RoleplayHeader({
  active,
  children,
}: {
  active: 'discover' | 'conversations';
  children?: ReactNode;
}) {
  const currentPath = active === 'discover' ? '/characters' : '/chats';

  useEffect(() => {
    rememberRoleplayView(currentPath);
  }, [currentPath]);

  return (
    <header className="sticky top-0 z-30 w-full shrink-0 border-b border-border/70 bg-background/95 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-1 backdrop-blur-xl">
      <h1 className="sr-only">角色扮演</h1>
      <nav
        aria-label="角色栏目"
        className="mx-auto flex w-full max-w-screen-xl gap-2 px-4 sm:px-6 lg:px-8"
      >
        {VIEWS.map((view) => (
          <Link
            key={view.key}
            href={view.href}
            scroll={false}
            aria-current={view.key === active ? 'page' : undefined}
            onClick={() => {
              rememberRoleplayScroll(currentPath);
              rememberRoleplayView(view.href);
            }}
            className={cn(
              'relative flex min-h-11 min-w-20 items-center justify-center px-4 pb-2 text-sm font-semibold transition-colors',
              'focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              view.key === active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {view.label}
            {view.key === active ? (
              <span
                className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
                aria-hidden
              />
            ) : null}
          </Link>
        ))}
        <Link
          href="/creation/characters/new"
          aria-label="创作角色卡"
          className="group ml-auto inline-flex min-h-11 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4d5b6] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[#f3e6c9]/35 bg-[linear-gradient(110deg,#e3d5b8,#cdbb95)] px-3 text-[13px] font-semibold text-[#382f20] shadow-[0_3px_12px_rgba(190,164,108,0.14)] transition-colors group-active:bg-[#c3af86] group-active:bg-none">
            <PenLine className="size-3.5" strokeWidth={1.8} aria-hidden />
            创作角色
          </span>
        </Link>
      </nav>
      {children}
    </header>
  );
}
