'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GalleryController } from './use-plaza-gallery';
import { PlazaCard } from './plaza-card';

import { placePlazaItems, type Placement } from './plaza-masonry-layout';

function canPrefetch() {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  return (
    document.visibilityState === 'visible' &&
    navigator.onLine !== false &&
    !connection?.saveData &&
    !['slow-2g', '2g'].includes(connection?.effectiveType ?? '')
  );
}

function useColumnLoading(
  view: GalleryController,
  ends: React.RefObject<HTMLDivElement>,
  more: boolean,
  reveal: () => void,
  count: number
) {
  const guard = useRef(false);
  const { performancePolicy } = view;
  const {
    hasNextPage,
    isFetching,
    isError,
    paginationInvalidated,
    isPlaceholderData,
    fetchNextPage,
  } = view.feed;
  useEffect(() => {
    guard.current = false;
    if (!ends.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || guard.current || document.hidden)
          return;
        if (more) {
          guard.current = true;
          reveal();
          return;
        }
        if (!hasNextPage || isFetching || isError || paginationInvalidated || isPlaceholderData)
          return;
        guard.current = true;
        void fetchNextPage().finally(() => {
          guard.current = false;
        });
      },
      { rootMargin: performancePolicy.imagePlaza.list.renderMoreRootMargin }
    );
    ends.current
      .querySelectorAll('[data-plaza-column-end]')
      .forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [
    ends,
    more,
    reveal,
    count,
    hasNextPage,
    isFetching,
    isError,
    paginationInvalidated,
    isPlaceholderData,
    fetchNextPage,
    performancePolicy,
  ]);
}

export function PlazaMasonry({ view }: { view: GalleryController }) {
  const { items, performancePolicy, feed } = view;
  const budget = performancePolicy.imagePlaza.list;
  const [limit, setLimit] = useState(() =>
    view.restoring.current ? Infinity : budget.initialRenderCount
  );
  const [width, setWidth] = useState(160);
  const container = useRef<HTMLDivElement>(null);
  const assigned = useRef<Placement[]>([]);
  const rendered = useMemo(() => items.slice(0, limit), [items, limit]);
  const layout = placePlazaItems(rendered, width, assigned.current);
  assigned.current = layout.placements;
  const reveal = useMemo(
    () => () => setLimit((value) => value + budget.renderBatchSize),
    [budget.renderBatchSize]
  );
  useColumnLoading(view, container, rendered.length < items.length, reveal, rendered.length);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') setLimit(Infinity);
    const node = container.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(1, (node.clientWidth - 12) / 2));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        ref={container}
        data-plaza-masonry
        className={`grid grid-cols-2 items-start gap-3 ${feed.isPlaceholderData ? 'opacity-70' : ''}`}
      >
        {layout.columns.map((column, columnIndex) => (
          <div key={columnIndex} data-plaza-column className="flex min-w-0 flex-col gap-3">
            {column.map(({ work, index }) => (
              <PlazaCard
                key={work.id}
                work={work}
                eager={index < budget.eagerImageCount}
                priority={index < budget.highPriorityImageCount}
                imageWidths={performancePolicy.imagePlaza.feedImageWidths}
                imageQuality={performancePolicy.imagePlaza.feedImageQuality}
                useSamePending={view.pendingSourceWorkId === work.id}
                interactionDisabled={view.createConversation.isPending}
                onPreviewSettled={view.handleCriticalPreviewSettled}
                onPrefetch={() => {
                  if (canPrefetch()) view.router.prefetch(`/create/work/${work.id}`);
                }}
                onOpen={() => view.saveReturn(work.id)}
                onUseSame={() => view.startStudio(work.id)}
              />
            ))}
            <div data-plaza-column-end aria-hidden className="h-px" />
          </div>
        ))}
      </div>
      {rendered.length < items.length ? (
        <p className="py-4 text-center text-xs text-muted-foreground">继续下滑加载更多</p>
      ) : null}
    </>
  );
}
