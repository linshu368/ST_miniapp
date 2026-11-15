'use client';

import { useEffect, useRef } from 'react';
import type { DramaSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { useDramaLibraryStore, type DramaLibraryPosition } from '@/stores/drama-library-store';
import { EmptyState, LibraryRow } from './drama-theater-cards';

function readLibraryPosition(element: HTMLDivElement, preferredId?: string): DramaLibraryPosition {
  const bounds = element.getBoundingClientRect();
  const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-library-drama-id]'));
  const anchor = preferredId
    ? rows.find((row) => row.dataset.libraryDramaId === preferredId)
    : rows.find((row) => row.getBoundingClientRect().bottom > bounds.top + 1);
  return {
    scroll: element.scrollTop,
    anchorId: anchor?.dataset.libraryDramaId ?? null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  };
}

function saveLibraryPosition(filter: 'saved' | 'recent', position: DramaLibraryPosition) {
  const state = useDramaLibraryStore.getState();
  state.setBrowse({ libraryPositions: { ...state.browse.libraryPositions, [filter]: position } });
}

/** 追剧栏目：已收藏/最近看过，各自保留本会话滚动位置与行锚点。只在目录与本机记录就绪后挂载。 */
export function DramaLibraryTab({
  dramas,
  recent,
  onDiscover,
}: {
  dramas: DramaSummary[];
  recent: DramaSummary[];
  onDiscover: () => void;
}) {
  const filter = useDramaLibraryStore((state) => state.browse.libraryFilter);
  const setBrowse = useDramaLibraryStore((state) => state.setBrowse);
  const history = useDramaLibraryStore((state) => state.history);
  const saved = useDramaLibraryStore((state) => state.saved);
  const persistent = useDramaLibraryStore((state) => state.persistent);
  const libraryScrollRef = useRef<HTMLDivElement>(null);
  const openedLibraryPosition = useRef<DramaLibraryPosition | null>(null);
  const library =
    filter === 'recent'
      ? recent
      : saved.flatMap((id) => dramas.find((drama) => drama.id === id) ?? []);

  useEffect(() => {
    const element = libraryScrollRef.current;
    if (!element) return;
    let position = useDramaLibraryStore.getState().browse.libraryPositions[filter];
    openedLibraryPosition.current = null;
    element.scrollTop = position.scroll;
    const anchor = Array.from(
      element.querySelectorAll<HTMLElement>('[data-library-drama-id]')
    ).find((row) => row.dataset.libraryDramaId === position.anchorId);
    if (anchor) {
      // 最近看过会重排，优先找回刚点过的那部，而不是死守失效的像素位置。
      element.scrollTop +=
        anchor.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        position.anchorOffset;
    }
    const remember = () => {
      position = readLibraryPosition(element);
    };
    remember();
    element.addEventListener('scroll', remember, { passive: true });
    return () => {
      element.removeEventListener('scroll', remember);
      saveLibraryPosition(filter, openedLibraryPosition.current ?? position);
    };
  }, [filter]);

  return (
    <div className="absolute inset-x-0 bottom-[var(--app-nav-space)] top-[calc(60px+env(safe-area-inset-top))] flex flex-col px-4">
      <div className="flex shrink-0 items-center gap-2 pb-4 pt-3">
        {(['saved', 'recent'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setBrowse({ libraryFilter: value })}
            className={cn(
              'min-h-11 rounded-full px-5 text-sm',
              filter === value
                ? 'bg-[#dfd2cf] text-[#211d20] font-semibold'
                : 'bg-white/5 text-[#eee7e2]/55'
            )}
          >
            {value === 'saved' ? '已收藏' : '最近看过'}
          </button>
        ))}
        <span className="ml-auto text-xs text-[#eee7e2]/35">{library.length} 部</span>
      </div>
      <div
        key={filter}
        ref={libraryScrollRef}
        aria-label={filter === 'saved' ? '已收藏短剧列表' : '最近看过短剧列表'}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-5"
      >
        {library.length ? (
          <div className="space-y-5">
            {library.map((drama) => (
              <LibraryRow
                key={drama.id}
                drama={drama}
                progress={history[drama.id]}
                queue={library}
                onOpen={() => {
                  if (!libraryScrollRef.current) return;
                  const position = readLibraryPosition(libraryScrollRef.current, drama.id);
                  openedLibraryPosition.current = position;
                  saveLibraryPosition(filter, position);
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title={filter === 'saved' ? '喜欢的故事，留在这里' : '从一个好故事开始'}
            detail={
              filter === 'saved'
                ? '看到喜欢的剧，点一下「收藏」，下次接着看。'
                : '看过的短剧会自动留在这里，随时继续。'
            }
            action="去发现好剧"
            onAction={onDiscover}
          />
        )}
        <p className="px-4 pb-3 pt-7 text-center text-[11px] leading-relaxed text-[#eee7e2]/35">
          {persistent
            ? '收藏与观看进度保存在当前设备'
            : '当前无法保存到设备，记录仅在本次打开期间保留'}
        </p>
      </div>
    </div>
  );
}
