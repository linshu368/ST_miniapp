'use client';
import { ImageIcon, LoaderCircle, WandSparkles } from 'lucide-react';
import type { GalleryController } from './use-plaza-gallery';
import { PlazaMasonry } from './plaza-masonry';

export function PlazaGalleryContent({ view }: { view: GalleryController }) {
  const {
    feed,
    items,
    search,
    selectedTags,
    media,
    setSearch,
    setSelectedTags,
    setMedia,
    startStudio,
    refreshFeed,
  } = view;
  return (
    <section className="px-3 py-4">
      {feed.paginationInvalidated ? (
        <button
          type="button"
          onClick={() => void refreshFeed()}
          className="mb-3 w-full rounded-xl bg-card p-3 text-xs text-primary"
        >
          排序已更新，点击刷新后继续浏览
        </button>
      ) : null}
      {feed.isLoading ? (
        <FeedSkeleton />
      ) : feed.isError && items.length === 0 ? (
        <EmptyState
          icon={<ImageIcon />}
          title="广场暂时走丢了"
          action="重新加载"
          onAction={() => void feed.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<WandSparkles />}
          title={
            search || selectedTags.length || media !== 'all' ? '没有找到对应作品' : '还没有公开作品'
          }
          action={search || selectedTags.length || media !== 'all' ? '查看全部' : '生成第一个作品'}
          onAction={() => {
            if (search || selectedTags.length || media !== 'all') {
              setSearch('');
              setSelectedTags([]);
              setMedia('all');
            } else startStudio();
          }}
        />
      ) : (
        <PlazaMasonry key={view.feedViewKey} view={view} />
      )}
      <div className="flex h-16 items-center justify-center text-xs text-muted-foreground">
        {feed.isError && items.length > 0 ? (
          <button type="button" onClick={() => void refreshFeed()}>
            加载失败，点击刷新后继续
          </button>
        ) : feed.isFetchingNextPage ? (
          <LoaderCircle className="size-5 animate-spin" />
        ) : !feed.hasNextPage && items.length > 0 && !feed.isPlaceholderData ? (
          '已经到底啦'
        ) : null}
      </div>
    </section>
  );
}

function FeedSkeleton() {
  const ratios = ['2 / 3', '3 / 4', '1 / 1', '3 / 4', '2 / 3', '4 / 5', '2 / 3', '3 / 4'];
  const columns = splitIntoColumns(ratios, 2);
  return (
    <div className="grid grid-cols-2 items-start gap-3" aria-busy="true" aria-label="加载中">
      {columns.map((column, columnIndex) => (
        <div key={columnIndex} className="flex min-w-0 flex-col gap-3">
          {column.map((ratio, rowIndex) => (
            <div
              key={`${columnIndex}-${rowIndex}`}
              className="overflow-hidden rounded-[1.5rem] bg-muted/50 ring-1 ring-border/50"
            >
              <div className="w-full animate-pulse bg-muted" style={{ aspectRatio: ratio }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function splitIntoColumns<T>(items: readonly T[], columnCount: number): T[][] {
  const columns = Array.from({ length: columnCount }, () => [] as T[]);
  for (const [index, item] of items.entries()) {
    columns[index % columnCount]!.push(item);
  }
  return columns;
}

function EmptyState(props: {
  icon: React.ReactNode;
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-[48vh] flex-col items-center justify-center gap-4 text-center text-muted-foreground">
      <div className="grid size-14 place-items-center rounded-full bg-card text-primary ring-1 ring-border">
        {props.icon}
      </div>
      <p className="text-sm font-bold text-foreground">{props.title}</p>
      <button
        type="button"
        onClick={props.onAction}
        className="rounded-full bg-primary px-5 py-2.5 text-xs font-black text-primary-foreground"
      >
        {props.action}
      </button>
    </div>
  );
}
