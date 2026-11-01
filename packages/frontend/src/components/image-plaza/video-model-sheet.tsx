'use client';

import { Check, X } from 'lucide-react';
import type { VideoPlazaModel } from '@miniapp/shared';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';

export function VideoModelSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: VideoPlazaModel[];
  selectedId: string;
  onSelect: (model: VideoPlazaModel) => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[76dvh] w-full max-w-3xl flex-col overflow-hidden overscroll-contain rounded-t-[1.75rem] border-border bg-card p-0"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          <SheetTitle className="min-w-0 flex-1 text-base font-bold">选择视频模型</SheetTitle>
          <SheetClose
            aria-label="关闭"
            className="grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-5" aria-hidden />
          </SheetClose>
        </div>
        <SheetDescription className="shrink-0 px-5 pb-3 pt-3 text-sm leading-5">
          模型会决定附图用途、时长、清晰度与声音选项。
        </SheetDescription>
        <div className="chat-scroll-area min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-1">
          {props.models.map((model) => (
            <SheetClose key={model.id} asChild>
              <button
                type="button"
                aria-pressed={model.id === props.selectedId}
                onClick={() => props.onSelect(model)}
                className={`min-h-24 w-full rounded-2xl border px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card ${model.id === props.selectedId ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-background/70'}`}
              >
                <span className="flex items-start justify-between gap-3 text-base font-black leading-6">
                  <span className="min-w-0 break-words">{model.name}</span>
                  {model.id === props.selectedId ? (
                    <Check className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
                  ) : null}
                </span>
                <span className="mt-1.5 block break-words text-sm leading-5 text-muted-foreground">
                  {model.description}
                </span>
              </button>
            </SheetClose>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
