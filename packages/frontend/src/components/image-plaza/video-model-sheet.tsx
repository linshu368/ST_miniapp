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
      <SheetContent side="bottom" className="mx-auto max-h-[76dvh] w-full max-w-3xl rounded-t-3xl">
        <div className="flex items-center border-b border-border pb-3">
          <SheetTitle className="flex-1">选择视频模型</SheetTitle>
          <SheetClose aria-label="关闭" className="grid size-9 place-items-center">
            <X className="size-5" />
          </SheetClose>
        </div>
        <SheetDescription className="py-3 text-xs">
          模型会决定附图用途、时长、清晰度与声音选项。
        </SheetDescription>
        <div className="space-y-2 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {props.models.map((model) => (
            <SheetClose key={model.id} asChild>
              <button
                type="button"
                onClick={() => props.onSelect(model)}
                className={`w-full rounded-xl border p-3 text-left ${model.id === props.selectedId ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
              >
                <span className="flex items-center justify-between text-sm font-black">
                  {model.name}
                  {model.id === props.selectedId ? <Check className="size-4 text-primary" /> : null}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
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
