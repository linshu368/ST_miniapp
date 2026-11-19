'use client';

import Image from 'next/image';
import {
  CharacterEditorModal,
  CharacterFullscreenEditor,
  CharacterPolishDialog,
} from './character-editor-dialogs';

import { FIELDS } from './character-editor-fields';
import type { EditorModel } from './use-character-editor';
export function CharacterEditorDialogHost({ model }: { model: EditorModel }) {
  const {
    local,
    draft,
    coverUrl,
    busy,
    editing,
    setEditing,
    fullCover,
    setFullCover,
    notice,
    recoveryOpen,
    setRecoveryOpen,
    session,
    sessionRef,
    polishOpen,
    change,
    keepPolish,
    closePolish,
    discardPolish,
    stopPolish,
    polish,
    loadLatestKeepingBackup,
  } = model;
  return (
    <>
      {recoveryOpen && (
        <CharacterEditorModal
          compact
          title="载入最新版本"
          onClose={() => {
            if (!busy) setRecoveryOpen(false);
          }}
        >
          <div className="px-5 py-6 text-sm leading-7 text-foreground/80">
            <p>
              会先将当前修改保留为一份本地备份，再载入最新角色资料。之后仍可在「我的创作」里找到这份备份。
            </p>
            {notice && (
              <p role="alert" className="mt-3 text-destructive">
                {notice}
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadLatestKeepingBackup()}
              className="mt-6 min-h-12 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? '正在保留修改…' : '保留修改并载入'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRecoveryOpen(false)}
              className="mt-2 min-h-12 w-full text-sm"
            >
              继续编辑当前稿
            </button>
          </div>
        </CharacterEditorModal>
      )}
      {editing && (
        <CharacterFullscreenEditor
          title={FIELDS.find((field) => field.key === editing)!.label}
          value={draft[editing]}
          placeholder={FIELDS.find((field) => field.key === editing)!.placeholder}
          onChange={(text) => change(editing, text)}
          onClose={() => {
            setEditing(null);
            void local.flush();
          }}
        />
      )}
      {fullCover && coverUrl && (
        <CharacterEditorModal title="角色形象" onClose={() => setFullCover(false)}>
          <div className="relative min-h-0 w-full flex-1 pb-[env(safe-area-inset-bottom)]">
            <Image
              src={coverUrl}
              alt={draft.name || '角色形象'}
              fill
              sizes="100vw"
              unoptimized
              className="object-contain"
            />
          </div>
        </CharacterEditorModal>
      )}
      {session && polishOpen && (
        <CharacterPolishDialog
          session={session}
          onClose={closePolish}
          onStop={stopPolish}
          onDiscard={discardPolish}
          onRetry={() => void polish(session.target, true)}
          onEdit={(result) => {
            if (sessionRef.current) keepPolish({ ...sessionRef.current, result });
          }}
          onApply={() => applyPolish(model)}
        />
      )}
    </>
  );
}

function applyPolish(model: EditorModel) {
  const { session, local, setPolishFeedback, sessionRef, setSession, closePolish } = model;
  if (!session) return;

  if (session.state === 'loading' || !session.result.trim()) return;
  const { target, result } = session;
  local.update((current) => {
    const candidates = { ...current.polishCandidates };
    delete candidates[target];
    return {
      ...current,
      draft: { ...current.draft, [target]: result },
      undo: { ...current.undo, [target]: current.draft[target] },
      polishCandidates: candidates,
    };
  });
  setPolishFeedback((current) => ({ ...current, [target]: '已采用润色内容' }));
  sessionRef.current = null;
  setSession(null);
  closePolish();
}
