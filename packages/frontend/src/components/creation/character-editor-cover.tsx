'use client';

import { cn } from '@/lib/utils';
import { Expand, ImagePlus, LoaderCircle, Sparkles, Upload } from 'lucide-react';
import Image from 'next/image';

import { requiredMark } from './character-editor-fields';
import type { EditorModel } from './use-character-editor';
export function CharacterEditorCover({ model }: { model: EditorModel }) {
  const {
    draft,
    coverAssetId,
    cover,
    coverUrl,
    upload,
    createStudio,
    busy,
    setFullCover,
    showRequired,
    coverError,
    fileInput,
    uploadCover,
    generateCover,
    correctionHint,
  } = model;
  return (
    <>
      <section className="mt-6" aria-labelledby="creator-cover">
        <h2 id="creator-cover" className="mb-4 scroll-mt-5 text-sm font-medium text-foreground">
          角色形象{requiredMark}
        </h2>
        <div className="flex flex-col items-center">
          <div
            className={cn(
              'relative aspect-[3/4] w-[min(61vw,224px)] rounded-[20px] border border-border bg-card p-1.5 shadow-lg shadow-black/10',
              showRequired && !coverAssetId && 'border-destructive/60'
            )}
          >
            {coverUrl ? (
              <button
                type="button"
                className="relative block size-full overflow-hidden rounded-[14px]"
                aria-label="全屏查看角色形象"
                onClick={() => setFullCover(true)}
              >
                <Image
                  src={coverUrl}
                  alt={draft.name ? `${draft.name}的角色形象` : '角色形象'}
                  className="size-full object-cover object-top"
                  fill
                  sizes="224px"
                  unoptimized
                />
                <Expand className="absolute bottom-2 right-2 size-8 rounded-lg bg-black/50 p-2 text-white" />
              </button>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border bg-card text-xs text-muted-foreground">
                <ImagePlus className="size-9 text-primary" strokeWidth={1.2} />
                建立角色形象
              </div>
            )}
          </div>
          <div className="mt-3 grid w-[min(61vw,224px)] grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-secondary/50 text-[13px] text-primary disabled:opacity-40"
            >
              {upload.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              上传
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void generateCover()}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-secondary/50 text-[13px] text-primary disabled:opacity-40"
            >
              {createStudio.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {createStudio.isPending ? '进入中…' : '生成'}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="上传角色封面"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void uploadCover(file);
            }}
          />
          {coverError && (
            <p role="alert" className="mt-2 text-xs leading-6 text-destructive">
              {coverError}
            </p>
          )}
          {correctionHint('角色形象')}
          {cover.isError && (
            <button
              type="button"
              className="mt-2 min-h-11 text-xs text-destructive"
              onClick={() => void cover.refetch()}
            >
              封面暂未加载，点击重试
            </button>
          )}
        </div>
      </section>
    </>
  );
}
