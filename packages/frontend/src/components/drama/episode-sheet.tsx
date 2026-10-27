'use client';

import { Check, X } from 'lucide-react';
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

interface EpisodeSheetProps {
  title: string;
  videos: VideoItem[];
  currentVideoId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
}

export function EpisodeSheet({
  title,
  videos,
  currentVideoId,
  open,
  onOpenChange,
  onSelect,
}: EpisodeSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-white/15 bg-white/[0.08] px-4 text-sm text-white transition hover:bg-white/15"
        >
          <span className="font-semibold">选集</span>
          <span className="text-white/75">共 {videos.length} 集 · 查看全部 ›</span>
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[75dvh] max-w-lg rounded-t-3xl px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-3 motion-reduce:animate-none"
        overlayClassName="backdrop-blur-none"
      >
        <div aria-hidden className="mx-auto mb-5 h-1 w-9 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center justify-between gap-3">
          <SheetTitle className="text-lg font-semibold">全部选集</SheetTitle>
          <SheetClose
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06]"
            aria-label="关闭选集"
          >
            <X className="h-5 w-5" />
          </SheetClose>
        </div>
        <SheetDescription className="mb-5 line-clamp-2">
          {title} · 共 {videos.length} 集
        </SheetDescription>
        <div className="grid max-h-[45dvh] grid-cols-5 gap-2 overflow-y-auto overscroll-contain pb-1">
          {videos.map((video, index) => {
            const active = video.id === currentVideoId;
            return (
              <button
                key={video.id}
                type="button"
                aria-label={`第 ${index + 1} 集${active ? '，当前播放' : ''}`}
                aria-current={active ? 'true' : undefined}
                disabled={!video.playable}
                onClick={() => onSelect(video.id)}
                className={cn(
                  'relative flex min-h-14 items-center justify-center rounded-xl border text-sm font-semibold transition disabled:opacity-40',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-foreground/[0.03] hover:border-primary/50'
                )}
              >
                {index + 1}
                {active ? (
                  <Check aria-hidden className="absolute bottom-1 right-1 h-3 w-3" />
                ) : null}
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
