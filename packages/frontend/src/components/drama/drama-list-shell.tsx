import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { value: 'theater', label: '剧场' },
  { value: 'library', label: '追剧' },
] as const;
/** 启动 HTML 和真实列表共用栏目，避免维护两套布局。 */
export function DramaListHeader({
  tab: selectedTab,
  onTabChange,
  onSearch,
}: {
  tab: 'theater' | 'library';
  onTabChange?: (tab: 'theater' | 'library') => void;
  onSearch?: () => void;
}) {
  return (
    <header
      className={cn(
        'relative bg-[#121113] px-5',
        selectedTab === 'library' && 'pt-[env(safe-area-inset-top)]'
      )}
    >
      <div className="flex h-[60px] items-center justify-between">
        <nav aria-label="短剧栏目" className="flex h-full items-center gap-7">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-current={selectedTab === tab.value ? 'page' : undefined}
              onClick={() => onTabChange?.(tab.value)}
              className={cn(
                'relative flex h-full min-w-11 items-center justify-center text-[18px] transition-colors',
                selectedTab === tab.value
                  ? 'font-bold text-[#eee7e2]'
                  : 'font-medium text-[#eee7e2]/50'
              )}
            >
              {tab.label}
              {selectedTab === tab.value ? (
                <span aria-hidden className="absolute bottom-1.5 h-0.5 w-4 rounded-full bg-white" />
              ) : null}
            </button>
          ))}
        </nav>
        <button
          type="button"
          aria-label="搜索短剧"
          onClick={onSearch}
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full active:bg-white/10"
        >
          <Search className="h-[22px] w-[22px]" />
        </button>
      </div>
    </header>
  );
}

export function DramaGridSkeleton() {
  return (
    <div className="space-y-5 px-4 pt-5" aria-label="短剧加载中">
      <div className="h-11 animate-pulse rounded-xl bg-white/5" />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="aspect-[3/4] animate-pulse rounded-lg bg-white/5" />
        ))}
      </div>
    </div>
  );
}

export function DramaListShell() {
  return (
    <main
      aria-label="短剧"
      className="fixed inset-0 z-30 overflow-hidden bg-[#121113] text-[#eee7e2]"
    >
      <div className="absolute inset-x-0 bottom-[var(--app-nav-space)] top-[env(safe-area-inset-top)] mx-auto max-w-lg overflow-y-auto">
        <DramaListHeader tab="theater" />
        <DramaGridSkeleton />
      </div>
    </main>
  );
}
