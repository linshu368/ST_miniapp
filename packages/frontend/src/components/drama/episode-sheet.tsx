'use client';

import { useEffect, useRef, useState } from 'react';
import { AudioLines, ChevronRight, ListVideo, Star, X } from 'lucide-react';
import type { VideoItem } from '@miniapp/shared';

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { DramaTags } from './drama-tags';
import { useDramaSheetDismiss } from './use-drama-sheet-dismiss';

interface EpisodeSheetProps {
  title: string;
  description: string;
  tags: string[];
  coverUrl: string | null;
  saved: boolean;
  onToggleSaved: () => void;
  tab: 'episodes' | 'intro';
  onTabChange: (tab: 'episodes' | 'intro') => void;
  videos: VideoItem[];
  currentVideoId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  showTrigger?: boolean;
}

const PAGE_SIZE = 30;

export function EpisodeSheet({
  title,
  description,
  tags,
  coverUrl,
  saved,
  onToggleSaved,
  tab,
  onTabChange,
  videos,
  currentVideoId,
  open,
  onOpenChange,
  onSelect,
  showTrigger = true,
}: EpisodeSheetProps) {
  const dismiss = useDramaSheetDismiss(open, onOpenChange);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const currentIndex = Math.max(
    0,
    videos.findIndex((video) => video.id === currentVideoId)
  );
  const [group, setGroup] = useState(0);
  const [episodeList, setEpisodeList] = useState<HTMLDivElement | null>(null);
  const rangeList = useRef<HTMLDivElement>(null);
  const wasEpisodes = useRef(false);
  const alignCurrent = useRef(false);
  useEffect(() => {
    const viewingEpisodes = open && tab === 'episodes';
    if (viewingEpisodes && !wasEpisodes.current) {
      alignCurrent.current = true;
      setGroup(Math.floor(currentIndex / PAGE_SIZE));
    }
    if (!viewingEpisodes) alignCurrent.current = false;
    wasEpisodes.current = viewingEpisodes;
  }, [open, tab, currentIndex]);
  useEffect(() => {
    if (
      !open ||
      tab !== 'episodes' ||
      !episodeList ||
      !alignCurrent.current ||
      group !== Math.floor(currentIndex / PAGE_SIZE)
    )
      return;
    // Portal 挂载后只定位一次，不随续播或用户自行切组反复抢滚动。
    const frame = requestAnimationFrame(() => {
      const active = episodeList.querySelector<HTMLElement>('[aria-current="true"]');
      if (!active || !alignCurrent.current) return;
      const bounds = episodeList.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      if (activeBounds.top < bounds.top) episodeList.scrollTop += activeBounds.top - bounds.top;
      else if (activeBounds.bottom > bounds.bottom)
        episodeList.scrollTop += activeBounds.bottom - bounds.bottom;
      const ranges = rangeList.current;
      const selectedRange = ranges?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (ranges && selectedRange) {
        const rangeBounds = ranges.getBoundingClientRect();
        const selectedBounds = selectedRange.getBoundingClientRect();
        if (selectedBounds.left < rangeBounds.left)
          ranges.scrollLeft += selectedBounds.left - rangeBounds.left;
        else if (selectedBounds.right > rangeBounds.right)
          ranges.scrollLeft += selectedBounds.right - rangeBounds.right;
      }
      alignCurrent.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, tab, group, episodeList, currentIndex]);
  const start = group * PAGE_SIZE;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {showTrigger ? (
        <SheetTrigger asChild>
          <button
            type="button"
            onClick={() => onTabChange('episodes')}
            aria-label={`选集，第 ${currentIndex + 1} 集 / 共 ${videos.length} 集`}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-white/[0.08] px-3 text-[13px] text-[#eee7e2] active:bg-white/15"
          >
            <ListVideo className="h-4 w-4" />
            <span className="font-medium">选集</span>
            <span className="text-[#eee7e2]/55">· 全 {videos.length} 集</span>
            <ChevronRight className="ml-auto h-4 w-4 text-[#eee7e2]/60" />
          </button>
        </SheetTrigger>
      ) : null}
      <SheetContent
        ref={dismiss.contentRef}
        side="bottom"
        className="mx-auto flex max-h-[78dvh] max-w-lg flex-col rounded-t-2xl border-white/5 bg-[#211f22] px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 text-[#eee7e2] motion-reduce:animate-none"
        overlayClassName="bg-black/35 backdrop-blur-none"
        onOpenAutoFocus={(event) => {
          // 首页由简介按钮受控打开，没有 SheetTrigger，也需把焦点还给实际入口。
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          closeButton.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          if (!opener.current?.isConnected) return;
          event.preventDefault();
          opener.current.focus({ preventScroll: true });
        }}
      >
        <div
          ref={dismiss.handleRef}
          data-sheet-drag-handle
          aria-label="下拉关闭选集"
          className="-mx-4 -mt-3 shrink-0 touch-none select-none px-4 pt-3"
        >
          <div aria-hidden className="mx-auto mb-3 h-1 w-8 rounded-full bg-white/15" />
          <div className="flex shrink-0 items-center gap-3">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                className="h-[68px] w-12 shrink-0 rounded-md object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-base font-semibold text-[#eee7e2]">
                {title}
              </SheetTitle>
              <SheetDescription className="mt-2 text-xs text-[#eee7e2]/40">
                共 {videos.length} 集 · 正在播放第 {currentIndex + 1} 集
              </SheetDescription>
            </div>
            <SheetClose
              ref={closeButton}
              className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center text-[#eee7e2]/60"
              aria-label="关闭选集"
            >
              <X className="h-5 w-5" />
            </SheetClose>
          </div>
        </div>
        <div role="tablist" aria-label="短剧详情" className="my-3 flex shrink-0 gap-6">
          {(['intro', 'episodes'] as const).map((value) => (
            <button
              key={value}
              id={`drama-${value}-tab`}
              role="tab"
              type="button"
              aria-controls={`drama-${value}-panel`}
              aria-selected={tab === value}
              onClick={() => onTabChange(value)}
              className={cn(
                'relative min-h-11 text-sm',
                tab === value
                  ? 'font-semibold text-[#eee7e2] after:absolute after:bottom-0 after:left-1/2 after:h-0.5 after:w-4 after:-translate-x-1/2 after:rounded-full after:bg-white'
                  : 'text-[#eee7e2]/40'
              )}
            >
              {value === 'intro' ? '简介' : '选集'}
            </button>
          ))}
        </div>
        {tab === 'intro' ? (
          <div
            role="tabpanel"
            id="drama-intro-panel"
            aria-labelledby="drama-intro-tab"
            className="min-h-0 overflow-y-auto overscroll-contain pb-4 text-sm leading-7 text-[#eee7e2]/65"
          >
            <DramaTags tags={tags} variant="detail" />
            <p className="whitespace-pre-line">{description || '暂时还没有简介，点开看看吧。'}</p>
          </div>
        ) : (
          <div
            role="tabpanel"
            id="drama-episodes-panel"
            aria-labelledby="drama-episodes-tab"
            className="flex min-h-0 flex-col"
          >
            {videos.length > PAGE_SIZE ? (
              <div
                ref={rangeList}
                aria-label="集数范围"
                className="mb-3 flex shrink-0 gap-2 overflow-x-auto [scrollbar-width:none]"
              >
                {Array.from({ length: Math.ceil(videos.length / PAGE_SIZE) }, (_, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-pressed={group === index}
                    onClick={() => {
                      alignCurrent.current = false;
                      setGroup(index);
                      if (episodeList) episodeList.scrollTop = 0;
                    }}
                    className={cn(
                      'min-h-11 shrink-0 px-3 text-xs',
                      group === index ? 'font-semibold text-[#eee7e2]' : 'text-[#eee7e2]/40'
                    )}
                  >
                    {index * PAGE_SIZE + 1}–{Math.min(videos.length, (index + 1) * PAGE_SIZE)}
                  </button>
                ))}
              </div>
            ) : null}
            <div
              ref={setEpisodeList}
              aria-label="剧集列表"
              className="min-h-0 overflow-y-auto overscroll-contain pb-1"
            >
              <div className="grid grid-cols-5 gap-2">
                {videos.slice(start, start + PAGE_SIZE).map((video, index) => {
                  const active = video.id === currentVideoId;
                  return (
                    <button
                      key={video.id}
                      type="button"
                      aria-label={`第 ${start + index + 1} 集${active ? '，当前播放' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      disabled={!video.playable}
                      onClick={() => onSelect(video.id)}
                      className={cn(
                        'relative flex min-h-12 items-center justify-center rounded-lg border text-base font-medium transition disabled:opacity-25',
                        active
                          ? 'border-transparent bg-[#c99ea7]/10 text-[#dbb2bb]'
                          : 'border-transparent bg-white/[0.055] text-[#eee7e2]/75 active:bg-white/15'
                      )}
                    >
                      {start + index + 1}
                      {active ? (
                        <AudioLines aria-hidden className="absolute bottom-1 right-1 h-2.5 w-2.5" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <div className="mt-4 shrink-0 border-t border-white/[0.05] pt-4">
          <button
            type="button"
            onClick={onToggleSaved}
            aria-pressed={saved}
            className={cn(
              'mx-auto flex min-h-11 w-[70%] items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors',
              saved ? 'bg-white/[0.07] text-[#eee7e2]/60' : 'bg-[#c99ea7] text-[#2b1d24]'
            )}
          >
            <Star className={cn('h-[18px] w-[18px]', saved && 'fill-current')} />
            {saved ? '已收藏' : '收藏这部剧'}
          </button>
          <p className="mt-3 text-center text-[10px] text-[#eee7e2]/30">收藏后可在「追剧」找到</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
