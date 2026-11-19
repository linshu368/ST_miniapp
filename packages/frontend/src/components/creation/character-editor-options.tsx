'use client';

import { cn } from '@/lib/utils';

import { INPUT, requiredMark, TAGS } from './character-editor-fields';
import type { EditorModel } from './use-character-editor';
export function CharacterEditorName({ model }: { model: EditorModel }) {
  const { draft, busy, showRequired, change, correctionHint } = model;
  return (
    <>
      <div className="mt-7">
        <label htmlFor="creator-name" className="text-sm font-medium text-foreground">
          名称{requiredMark}
        </label>
        <input
          id="creator-name"
          className={cn(
            INPUT,
            'mt-2.5',
            showRequired && !draft.name.trim() && 'border-destructive/60'
          )}
          required
          maxLength={120}
          autoComplete="off"
          value={draft.name}
          disabled={busy}
          aria-invalid={showRequired && !draft.name.trim()}
          placeholder="给角色或故事起个名字"
          onChange={(event) => change('name', event.target.value)}
        />
        {correctionHint('名称')}
      </div>
    </>
  );
}
export function CharacterEditorOptions({ model }: { model: EditorModel }) {
  const { character, local, draft, visibility, busy, showRequired, correctionHint } = model;
  return (
    <>
      <section className="mt-6 border-t border-border/70 pt-6">
        <fieldset>
          <legend
            id="creator-tags"
            className="mb-3 scroll-mt-5 text-sm font-medium text-foreground"
          >
            标签{requiredMark}
            <span className="ml-2 text-[11px] font-normal tabular-nums text-muted-foreground">
              {draft.tags.length} / 10
            </span>
          </legend>
          <div
            className={cn(
              'flex flex-wrap gap-x-2 gap-y-1',
              showRequired &&
                !draft.tags.length &&
                'rounded-xl outline outline-1 outline-offset-4 outline-destructive/40'
            )}
          >
            {[...TAGS, ...draft.tags.filter((tag) => !TAGS.includes(tag))].map((tag) => (
              <label
                className="relative inline-flex min-h-11 cursor-pointer items-center"
                key={tag}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={draft.tags.includes(tag)}
                  disabled={busy || (draft.tags.length >= 10 && !draft.tags.includes(tag))}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    local.update((current) => ({
                      ...current,
                      draft: {
                        ...current.draft,
                        tags: checked
                          ? current.draft.tags.length < 10
                            ? [...current.draft.tags, tag]
                            : current.draft.tags
                          : current.draft.tags.filter((value) => value !== tag),
                      },
                    }));
                  }}
                />
                <span className="inline-flex min-h-9 min-w-14 items-center justify-center rounded-full border border-input bg-card px-3 text-xs text-muted-foreground peer-checked:border-primary/50 peer-checked:bg-primary/10 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-40">
                  {tag}
                </span>
              </label>
            ))}
          </div>
          {correctionHint('标签')}
        </fieldset>
        <fieldset className="mt-7">
          <legend id="creator-visibility" className="mb-3 text-sm font-medium text-foreground">
            可见性{requiredMark}
          </legend>
          <div className="grid grid-cols-2 gap-2.5">
            {(['public', 'private'] as const).map((value) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name="creator-visibility"
                  className="peer sr-only"
                  checked={visibility === value}
                  disabled={busy}
                  onChange={() => local.update((current) => ({ ...current, visibility: value }))}
                />
                <span className="flex min-h-12 items-center justify-between rounded-xl border border-input bg-card px-3.5 text-[13px] text-foreground peer-checked:border-primary/60 peer-checked:bg-primary/10 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  {value === 'public' ? '公开' : '私密'}
                  <span
                    className={cn(
                      'size-3.5 rounded-full border border-muted-foreground/60',
                      visibility === value && 'border-4 border-primary'
                    )}
                  />
                </span>
                <span className="mt-2 block px-1 text-[11px] leading-6 text-muted-foreground">
                  {value === 'public' ? '公开后进入大厅' : '进入自己的空间，只有自己能看到'}
                </span>
              </label>
            ))}
          </div>
          {character?.published_revision && visibility === 'private' ? (
            <p className="mt-3 text-[11px] leading-6 text-muted-foreground">
              已收藏或使用过这张卡的玩家仍可继续聊天。
            </p>
          ) : null}
        </fieldset>
      </section>
    </>
  );
}
