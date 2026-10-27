'use client';

import { Check, SlidersHorizontal, X } from 'lucide-react';
import type { GetImagePlazaFeedData } from '@miniapp/shared';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export function StyleFilterSheet(props: {
  tags: GetImagePlazaFeedData['tags'];
  selected: string[];
  counts?: Record<string, number>;
  countsFailed?: boolean;
  onOpen?: () => void;
  onChange: (tags: string[]) => void;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          onClick={props.onOpen}
          className={`ml-auto shrink-0 rounded-full border px-4 py-1.5 text-[13px] ${
            props.selected.length
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground'
          }`}
        >
          <SlidersHorizontal className="mr-1 inline size-3.5" />
          全部风格{props.selected.length ? ` ${props.selected.length}` : ''}
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-h-[76dvh] w-full max-w-3xl rounded-t-3xl">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <SheetTitle className="flex-1">选择风格</SheetTitle>
          {props.selected.length ? (
            <button
              type="button"
              onClick={() => props.onChange([])}
              className="text-xs text-primary"
            >
              清空
            </button>
          ) : null}
          <SheetClose
            aria-label="关闭"
            className="grid size-9 place-items-center rounded-full bg-card"
          >
            <X className="size-4" />
          </SheetClose>
        </div>
        <SheetDescription className="py-3 text-xs">
          可多选；匹配任一所选风格的作品。
        </SheetDescription>
        <div className="grid grid-cols-2 gap-2 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:grid-cols-3">
          {props.tags.map((tag) => {
            const active = props.selected.includes(tag.id);
            const count = props.countsFailed ? '—' : (props.counts?.[tag.id] ?? '…');
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  props.onChange(
                    active
                      ? props.selected.filter((id) => id !== tag.id)
                      : [...props.selected, tag.id]
                  )
                }
                className={`flex min-h-12 items-center justify-between rounded-xl border px-3 text-left text-sm ${
                  active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
                }`}
              >
                <span>{tag.label}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {count}
                  {active ? <Check className="size-3.5 text-primary" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
