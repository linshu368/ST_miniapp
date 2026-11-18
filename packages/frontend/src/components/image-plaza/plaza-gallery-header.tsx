'use client';
import Link from 'next/link';
import { ChevronLeft, LoaderCircle, Search, Sparkles } from 'lucide-react';
import { ImagePlazaHistorySheet } from './image-plaza-history-sheet';
import { StyleFilterSheet } from './style-filter-sheet';
import type { GalleryController } from './use-plaza-gallery';

export function PlazaGalleryHeader({ view }: { view: GalleryController }) {
  const {
    saveReturn,
    startStudio,
    createConversation,
    media,
    setMedia,
    search,
    setSearch,
    sort,
    setSort,
  } = view;
  return (
    <header
      data-image-plaza-header
      className="sticky top-0 z-30 border-b border-border/60 bg-background/90 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-1 min-[360px]:gap-3">
        <div className="flex min-w-0 shrink-0 items-center gap-1 min-[360px]:gap-2">
          <Link
            href="/creation"
            onClick={() => saveReturn()}
            aria-label="返回创作"
            title="返回创作"
            className="grid size-11 shrink-0 place-items-center rounded-full border border-white/[0.07] bg-white/[0.035] text-foreground/85 transition-colors active:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronLeft className="size-[22px]" strokeWidth={1.8} aria-hidden />
          </Link>
          <h1 className="whitespace-nowrap text-base font-semibold leading-7 tracking-tight min-[360px]:text-xl">
            影像广场
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <ImagePlazaHistorySheet beforeNavigate={() => saveReturn()} />
          <button
            type="button"
            onClick={() => startStudio()}
            disabled={createConversation.isPending}
            className="inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-full bg-primary px-2 text-xs font-bold text-primary-foreground disabled:opacity-60 min-[360px]:gap-1.5 min-[360px]:px-3 sm:px-4"
          >
            {createConversation.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            去创作
          </button>
        </div>
      </div>
      <div
        className="mt-2 grid grid-cols-3 rounded-xl bg-card p-1 ring-1 ring-border"
        role="group"
        aria-label="媒体类型"
      >
        {(['all', 'image', 'video'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={media === value}
            onClick={() => {
              setMedia(value);
            }}
            className={`min-h-9 rounded-lg text-xs font-bold ${media === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            {value === 'all' ? '全部' : value === 'image' ? '图片' : '视频'}
          </button>
        ))}
      </div>
      <label className="mt-2 flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-muted-foreground">
        <Search className="size-4" aria-hidden />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索作品灵感、图片内容"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          aria-label="按作品灵感、内容搜索影像广场"
        />
      </label>
      <div className="mt-1 space-y-1">
        <GalleryTags view={view} />
        <div className="flex items-center gap-2" role="group" aria-label="作品排序">
          {(['recommended', 'latest'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={sort === value}
              onClick={() => {
                setSort(value);
                window.scrollTo({ top: 0, behavior: 'instant' });
              }}
              className={`relative shrink-0 whitespace-nowrap rounded-full border px-4 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${sort === value ? 'border-primary/30 bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground'}`}
            >
              {value === 'recommended' ? '推荐' : '最新'}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
function GalleryTags({ view }: { view: GalleryController }) {
  const { tags, selectedTags, setSelectedTags, availableTags, tagCounts } = view;
  return (
    <>
      {' '}
      {tags.some((item) => item.id !== 'all') ? (
        <div className="flex min-w-0 items-center gap-2 py-1" role="group" aria-label="作品标签">
          <div
            data-image-plaza-tags-scroll
            className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <button
              type="button"
              aria-pressed={selectedTags.length === 0}
              onClick={() => setSelectedTags([])}
              className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${selectedTags.length === 0 ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground'}`}
            >
              不限
            </button>
            {availableTags.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selectedTags.includes(item.id)}
                onClick={() =>
                  setSelectedTags((current) =>
                    current.length === 1 && current[0] === item.id ? [] : [item.id]
                  )
                }
                className={`relative shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${selectedTags.includes(item.id) ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
              >
                {item.label}{' '}
                <span className="text-xs font-normal opacity-70">
                  {tagCounts.isError ? '—' : (tagCounts.data?.counts[item.id] ?? '…')}
                </span>
              </button>
            ))}
          </div>
          <StyleFilterSheet
            tags={availableTags}
            selected={selectedTags}
            counts={tagCounts.data?.counts}
            countsFailed={tagCounts.isError}
            onChange={setSelectedTags}
          />
        </div>
      ) : null}
    </>
  );
}
