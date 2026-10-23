'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';

import { rememberRoleplayScroll, rememberRoleplayView } from '@/lib/roleplay-navigation';
import { cn } from '@/lib/utils';

const VIEWS = [
  { key: 'discover', href: '/', label: '发现' },
  { key: 'conversations', href: '/chats', label: '对话' },
] as const;

export function RoleplayHeader({
  active,
  children,
}: {
  active: 'discover' | 'conversations';
  children?: ReactNode;
}) {
  const currentPath = active === 'discover' ? '/' : '/chats';

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
      </nav>
      {children}
    </header>
  );
}
