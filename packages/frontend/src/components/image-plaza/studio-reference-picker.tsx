'use client';

import { useRef } from 'react';
import { ImagePlus } from 'lucide-react';

export const UNSUPPORTED_REFERENCE_NOTICE = '当前模型不支持参考图，可切换为 Seedream V5 PRO 模型';

export function StudioReferencePicker({
  supportsReference,
  onChoose,
  onNotice,
}: {
  supportsReference: boolean;
  onChoose: (file?: File) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          void onChoose(event.target.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => {
          if (!supportsReference) {
            onNotice(UNSUPPORTED_REFERENCE_NOTICE);
            return;
          }
          fileInput.current?.click();
        }}
        aria-label="添加参考图"
        title={supportsReference ? '添加参考图' : UNSUPPORTED_REFERENCE_NOTICE}
        className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ImagePlus className="size-5" aria-hidden />
      </button>
    </>
  );
}
