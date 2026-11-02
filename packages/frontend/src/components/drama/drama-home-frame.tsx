import type { ReactNode } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Shared HTML/interactive frame; no identity, storage, or business queries. */
export function DramaHomeFrame({
  controlsVisible = true,
  headerActions,
  onBrowse,
  children,
}: {
  controlsVisible?: boolean;
  headerActions?: ReactNode;
  onBrowse?: (tab: 'library' | 'theater') => void;
  children: ReactNode;
}) {
  return (
    <main
      aria-label="短剧首页"
      className="fixed inset-0 z-30 overflow-hidden bg-black text-[#eee7e2]"
    >
      <div className="relative mx-auto h-full max-w-lg">
        {controlsVisible ? (
          <header className="pointer-events-none relative z-20 flex [&_a]:pointer-events-auto [&_button]:pointer-events-auto h-[calc(60px+env(safe-area-inset-top))] items-center justify-between bg-gradient-to-b from-black/65 to-transparent px-5 pt-[env(safe-area-inset-top)]">
            <div className="flex h-full items-center gap-7">
              <h1 className="relative flex h-full items-center text-[18px] font-bold">
                推荐
                <span
                  aria-hidden
                  className="absolute bottom-1.5 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-white"
                />
              </h1>
              <Link
                href="/dramas"
                onClick={() => onBrowse?.('library')}
                className="flex min-h-11 items-center text-base text-[#eee7e2]/60"
              >
                追剧
              </Link>
            </div>
            <div className="-mr-2 flex items-center">
              {headerActions}
              <Link
                href="/dramas"
                aria-label="搜索短剧"
                onClick={() => onBrowse?.('theater')}
                className="flex h-11 w-11 items-center justify-center"
              >
                <Search className="h-[22px] w-[22px]" />
              </Link>
            </div>
          </header>
        ) : null}
        <div
          className={cn(
            'absolute inset-x-0 top-0',
            controlsVisible ? 'bottom-[var(--app-nav-space)]' : 'bottom-0'
          )}
        >
          {children}
        </div>
      </div>
    </main>
  );
}

export function DramaHomeLoading() {
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center text-sm text-[#eee7e2]/40"
    >
      <span className="animate-pulse">好戏，即将开始</span>
    </div>
  );
}
