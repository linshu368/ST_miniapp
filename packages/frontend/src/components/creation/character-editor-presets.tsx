'use client';

import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import { CREATOR_PRESET_CATALOG, type CreatorPresetId } from '@miniapp/shared';
import { cn } from '@/lib/utils';
import { useCreatorPresetDetailQuery } from '@/lib/api/creator-characters';
import { CharacterEditorModal } from './character-editor-dialogs';

export function CharacterPresetChoices({
  selected,
  disabled,
  onChange,
}: {
  selected: readonly CreatorPresetId[];
  disabled?: boolean;
  onChange: (selected: CreatorPresetId[]) => void;
}) {
  const [expanded, setExpanded] = useState<CreatorPresetId | null>(null);
  const [viewing, setViewing] = useState<CreatorPresetId | null>(null);
  const detail = useCreatorPresetDetailQuery(viewing);

  return (
    <>
      <div
        className="mt-2.5 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card"
        role="group"
        aria-label="预设模板，可多选"
      >
        {CREATOR_PRESET_CATALOG.map((preset) => {
          const checked = selected.includes(preset.id);
          const open = expanded === preset.id;
          return (
            <div key={preset.id} className={cn('transition-colors', checked && 'bg-primary/10')}>
              <div className="flex items-center">
                <label className="relative flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2 pl-3.5 pr-1">
                  <input
                    type="checkbox"
                    className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-default"
                    checked={checked}
                    disabled={disabled}
                    onChange={() =>
                      onChange(
                        checked
                          ? selected.filter((id) => id !== preset.id)
                          : [...selected, preset.id]
                      )
                    }
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-5 shrink-0 place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card peer-disabled:opacity-40',
                      checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/60 text-transparent'
                    )}
                  >
                    <Check className="size-3" strokeWidth={2.6} />
                  </span>
                  <span className="min-w-0 flex-1 text-balance text-[13px] font-medium leading-5 text-foreground peer-disabled:opacity-40">
                    {preset.title}
                  </span>
                </label>
                <button
                  type="button"
                  aria-label={`${preset.title}：适用与效果`}
                  aria-expanded={open}
                  aria-controls={`preset-detail-${preset.id}`}
                  className="flex min-h-11 shrink-0 items-center justify-center gap-0.5 px-2.5 text-[11px] text-muted-foreground"
                  onClick={() => setExpanded(open ? null : preset.id)}
                >
                  说明
                  <ChevronDown
                    className={cn('size-3.5 transition-transform', open && 'rotate-180')}
                  />
                </button>
              </div>
              {open && (
                <div
                  id={`preset-detail-${preset.id}`}
                  className="mx-3.5 space-y-2.5 border-t border-border/60 pb-3.5 pt-3 text-xs leading-6 text-muted-foreground"
                >
                  <p>
                    <span className="mr-2 text-foreground">适合</span>
                    {preset.use_cases}
                  </p>
                  <p>
                    <span className="mr-2 text-foreground">效果</span>
                    {preset.effect}
                  </p>
                  <button
                    type="button"
                    className="flex min-h-11 items-center gap-1 text-xs text-primary"
                    onClick={() => setViewing(preset.id)}
                  >
                    查看详情
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {viewing && (
        <CharacterEditorModal
          title={
            CREATOR_PRESET_CATALOG.find((preset) => preset.id === viewing)?.title ?? '预设详情'
          }
          onClose={() => setViewing(null)}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-5">
            {detail.isPending ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取详情…
              </p>
            ) : detail.isError ? (
              <div>
                <p role="alert" className="text-sm leading-7 text-foreground/80">
                  {detail.error.message || '详情暂时没有加载成功。'}
                </p>
                <button
                  type="button"
                  className="mt-3 min-h-11 rounded-xl border border-border px-4 text-sm text-primary"
                  onClick={() => void detail.refetch()}
                >
                  重新加载
                </button>
              </div>
            ) : (
              <pre
                aria-label="预设完整内容"
                className="min-w-0 select-text whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground/80"
              >
                {detail.data?.preset.content}
              </pre>
            )}
          </div>
        </CharacterEditorModal>
      )}
    </>
  );
}
