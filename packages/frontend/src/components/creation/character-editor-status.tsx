'use client';

import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';

import type { EditorModel } from './use-character-editor';
export function CharacterEditorStatus({ model }: { model: EditorModel }) {
  const { local, draft, sourceWishId, sourceWish, busy, setRecoveryOpen, recoveryDraftId } = model;
  return (
    <>
      {sourceWishId && (
        <aside className="mt-4 rounded-xl border border-primary/15 bg-primary/[0.04] px-3.5 py-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-primary">来自心愿墙的灵感</span>
            <Link
              href={`/wishes/${sourceWishId}`}
              className="flex min-h-11 items-center text-muted-foreground"
            >
              查看心愿
            </Link>
          </div>
          {sourceWish.data ? (
            <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
              {sourceWish.data.wish.body}
            </p>
          ) : sourceWish.isError ? (
            <p className="text-xs leading-6 text-muted-foreground">
              暂时无法查看原心愿，你可以继续创作。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">正在读取心愿…</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">公开发布后，作品会回应这个心愿。</p>
        </aside>
      )}
      {local.conflict && (
        <div
          className="mt-4 rounded-xl border border-warn/30 p-3 text-xs leading-6 text-warn"
          role="alert"
        >
          角色卡已有更新，本地草稿没有覆盖线上内容。
          <button
            className="ml-2 min-h-11 underline underline-offset-4"
            type="button"
            disabled={busy}
            onClick={() => setRecoveryOpen(true)}
          >
            载入最新版本
          </button>
        </div>
      )}
      {recoveryDraftId && (
        <p
          className="mt-3 rounded-xl border border-border px-3 py-2 text-xs leading-6 text-foreground/80"
          role="status"
        >
          刚才的修改已单独保留在我的创作。
          <Link
            href={`/creation/characters/new?draft=${recoveryDraftId}`}
            className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4"
          >
            查看修改备份
          </Link>
        </p>
      )}
    </>
  );
}
export function CharacterEditorSubmit({ model }: { model: EditorModel }) {
  const {
    missingFields,
    busy,
    publishing,
    unchanged,
    submitLabel,
    showRequired,
    notice,
    session,
    focusMissing,
    submit,
  } = model;
  return (
    <>
      <section className="mt-8 border-t border-border/70 pt-5">
        {showRequired && missingFields.length > 0 && (
          <div
            id="creator-missing"
            role="alert"
            className="mb-3 text-xs leading-7 text-destructive"
          >
            <span>请补全必填项：</span>
            <div className="flex flex-wrap gap-x-3">
              {missingFields.map((field) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => focusMissing(field)}
                  className="min-h-11 underline underline-offset-4"
                >
                  {field}
                </button>
              ))}
            </div>
          </div>
        )}
        {notice && (
          <p role="alert" className="mb-3 text-xs leading-7 text-destructive">
            {notice}
          </p>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || unchanged || session?.state === 'loading'}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {publishing ? '正在发布…' : busy ? '正在保存…' : unchanged ? '没有新修改' : submitLabel}
        </button>
      </section>
    </>
  );
}
