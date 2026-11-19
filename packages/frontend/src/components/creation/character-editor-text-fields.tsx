'use client';

import { cn } from '@/lib/utils';
import { Expand, Sparkles } from 'lucide-react';
import { type CharacterPolishTarget } from './character-editor-dialogs';
import { CreatorDocumentAttachments, CreatorDocumentImport } from './character-editor-documents';
import { CharacterPresetChoices } from './character-editor-presets';

import { FIELDS, INPUT, requiredMark } from './character-editor-fields';
import type { EditorModel } from './use-character-editor';
function CharacterEditorTextField({
  model,
  field,
}: {
  model: EditorModel;
  field: (typeof FIELDS)[number];
}) {
  const {
    local,
    draft,
    busy,
    setEditing,
    showRequired,
    importNotice,
    setImportNotice,
    change,
    correctionHint,
  } = model;
  const filesKey =
    field.key === 'background' ? 'backgroundFiles' : field.key === 'preset' ? 'presetFiles' : null;
  const files = filesKey ? draft[filesKey] : [];
  const invalid = showRequired && field.required && !draft[field.key].trim() && files.length === 0;
  const isPreset = field.key === 'preset';
  const importControl = filesKey && (
    <CreatorDocumentImport
      label={field.label}
      files={files}
      disabled={busy}
      onImport={(text, added) => {
        local.update((current) => ({
          ...current,
          draft: {
            ...current.draft,
            [field.key]: text
              ? [current.draft[field.key], text].filter(Boolean).join('\n\n')
              : current.draft[field.key],
            [filesKey]: [...current.draft[filesKey], ...added],
          },
        }));
      }}
      onMessage={(message) => setImportNotice((current) => ({ ...current, [field.key]: message }))}
    />
  );
  return (
    <section
      key={field.key}
      id={`creator-section-${field.key}`}
      className={cn('mt-6', field.divider && 'border-t border-border/70 pt-5')}
    >
      <div className="flex min-h-8 items-center justify-between gap-2">
        <label
          htmlFor={`creator-${field.key}`}
          className="scroll-mt-5 text-sm font-medium text-foreground"
        >
          {field.label}
          {field.required ? (
            requiredMark
          ) : (
            <span className="ml-2 text-[11px] font-normal text-muted-foreground">
              {isPreset ? '破甲词' : '选填'}
            </span>
          )}
        </label>
        {importControl}
      </div>
      {isPreset && (
        <p className="mt-1 text-xs leading-[22px] text-muted-foreground">
          用来引导模型的扮演和互动方式。不想自己写，可以直接复用下方的优质模板，也可以自行补充。
        </p>
      )}
      <div id={isPreset ? 'creator-preset-custom' : undefined}>
        <div className="relative mt-2.5">
          <textarea
            id={`creator-${field.key}`}
            className={cn(INPUT, 'resize-y pb-11', invalid && 'border-destructive/60')}
            rows={field.rows}
            value={draft[field.key]}
            required={field.required && !files.length}
            aria-invalid={invalid}
            placeholder={field.placeholder}
            disabled={busy}
            onChange={(event) => change(field.key, event.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(field.key)}
            aria-label={`全屏编辑${field.label}`}
            className="absolute bottom-1 right-1 grid size-11 place-items-center rounded-lg bg-card text-muted-foreground"
          >
            <Expand className="size-4" />
          </button>
        </div>
        {correctionHint(field.label)}
        {filesKey && (
          <CreatorDocumentAttachments
            files={files}
            disabled={busy}
            onRemove={(id) =>
              local.update((current) => ({
                ...current,
                draft: {
                  ...current.draft,
                  [filesKey]: current.draft[filesKey].filter((file) => file.id !== id),
                },
              }))
            }
          />
        )}
      </div>
      {(field.key === 'background' || field.key === 'preset') && importNotice[field.key] && (
        <p className="mt-2 text-[11px] leading-6 text-muted-foreground" role="status">
          {importNotice[field.key]}
        </p>
      )}
      <CharacterEditorFieldExtras model={model} field={field} />
    </section>
  );
}
function CharacterEditorFieldExtras({
  model,
  field,
}: {
  model: EditorModel;
  field: (typeof FIELDS)[number];
}) {
  const { local, draft, busy, session, polishFeedback, setPolishFeedback, polish } = model;
  const isPreset = field.key === 'preset';
  const canPolish = field.key === 'opening' || field.key === 'background';
  return (
    <>
      {isPreset && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-normal text-muted-foreground">也可以用模板补充</h3>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {draft.selectedPresetIds?.length
                ? `已选 ${draft.selectedPresetIds.length} · 可多选`
                : '可多选'}
            </span>
          </div>
          <CharacterPresetChoices
            selected={draft.selectedPresetIds ?? []}
            disabled={busy}
            onChange={(selectedPresetIds) =>
              local.update((current) => ({
                ...current,
                draft: { ...current.draft, selectedPresetIds },
              }))
            }
          />
        </div>
      )}
      {canPolish && (
        <div className="flex items-center justify-between gap-2">
          <span
            className="flex flex-wrap items-center gap-x-2 text-[11px] leading-6 text-muted-foreground"
            role="status"
          >
            {polishFeedback[field.key as CharacterPolishTarget]}
            {local.value.undo[field.key as CharacterPolishTarget] !== undefined && (
              <button
                type="button"
                className="min-h-11 text-primary underline underline-offset-4"
                disabled={busy}
                onClick={() => {
                  const target = field.key as CharacterPolishTarget;
                  local.update((current) => {
                    const undo = { ...current.undo };
                    const original = undo[target];
                    delete undo[target];
                    return {
                      ...current,
                      undo,
                      draft: {
                        ...current.draft,
                        [target]: original ?? current.draft[target],
                      },
                    };
                  });
                  setPolishFeedback((current) => ({ ...current, [target]: '已恢复上一版' }));
                }}
              >
                恢复上一版
              </button>
            )}
          </span>
          <button
            type="button"
            className="flex min-h-11 shrink-0 items-center gap-1.5 pl-3 text-xs text-primary disabled:opacity-40"
            disabled={busy || (session?.state === 'loading' && session.target !== field.key)}
            onClick={() => void polish(field.key as CharacterPolishTarget)}
            aria-label={`AI 润色${field.label}`}
          >
            <Sparkles className="size-4" />
            {session?.target === field.key && session.state === 'loading'
              ? '润色中…'
              : local.value.polishCandidates[field.key as CharacterPolishTarget]
                ? '查看润色结果'
                : 'AI 润色'}
          </button>
        </div>
      )}
    </>
  );
}
export function CharacterEditorTextFields({ model }: { model: EditorModel }) {
  return (
    <>
      {FIELDS.map((field) => (
        <CharacterEditorTextField key={field.key} model={model} field={field} />
      ))}
    </>
  );
}
