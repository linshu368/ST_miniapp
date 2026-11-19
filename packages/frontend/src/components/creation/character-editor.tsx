'use client';

import { useCreatorCharacterQuery, useCreatorCharactersQuery } from '@/lib/api/creator-characters';
import { usePageReady } from '@/lib/perf/page-ready';
import { createUuid } from '@/lib/uuid';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { CharacterEditorHeader } from './character-editor-header';

import { CharacterEditorCover } from './character-editor-cover';
import { CharacterEditorDialogHost } from './character-editor-dialog-host';
import { UUID } from './character-editor-fields';
import { CharacterEditorName, CharacterEditorOptions } from './character-editor-options';
import { CharacterEditorStatus, CharacterEditorSubmit } from './character-editor-status';
import { CharacterEditorTextFields } from './character-editor-text-fields';
import { useCharacterEditor } from './use-character-editor';
import type { EditorProps } from './use-character-editor-state';
export function CharacterEditorPage({ characterId }: { characterId?: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const requestedDraft = search.get('draft');
  const draftId =
    characterId ?? (requestedDraft && UUID.test(requestedDraft) ? requestedDraft : null);
  const list = useCreatorCharactersQuery(!characterId);
  const detail = useCreatorCharacterQuery(characterId);
  const ownerId = characterId ? detail.data?.character.owner_user_id : list.data?.owner_user_id;
  const route = characterId ? '/creation/characters/:id/edit' : '/creation/characters/new';
  usePageReady(route, false, false, characterId ? detail.isError : list.isError);
  useEffect(() => {
    if (!characterId && !draftId) {
      const params = new URLSearchParams(search.toString());
      params.set('draft', createUuid());
      router.replace(`/creation/characters/new?${params.toString()}`, { scroll: false });
    }
  }, [characterId, draftId, router, search]);
  const retry = () => {
    if (characterId) void detail.refetch();
    else void list.refetch();
  };
  if (characterId ? detail.isError : list.isError)
    return (
      <main className="mx-auto max-w-lg px-6 py-10">
        <Link
          href="/creation?tab=created"
          className="flex min-h-11 items-center gap-2 text-sm text-primary"
        >
          <ArrowLeft className="size-4" />
          返回我的创作
        </Link>
        <p className="mt-8 text-sm leading-7 text-foreground/80">
          {(characterId ? detail.error : list.error)?.message || '角色资料暂时没有加载成功。'}
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 min-h-11 rounded-xl border border-border px-5 text-sm"
        >
          重新加载
        </button>
      </main>
    );
  if (!draftId || !ownerId || (characterId && !detail.data))
    return (
      <main className="mx-auto max-w-lg px-6 py-10 text-sm text-muted-foreground" aria-busy>
        正在准备角色资料…
      </main>
    );
  return (
    <CharacterEditor
      key={`${ownerId}:${draftId}`}
      ownerId={ownerId}
      draftId={draftId}
      character={detail.data?.character}
      reloadCharacter={async () => {
        const result = await detail.refetch();
        if (result.error || !result.data)
          throw result.error ?? new Error('没读到最新的角色，再试一次吧。');
        return result.data.character;
      }}
    />
  );
}

function CharacterEditor(props: EditorProps) {
  const model = useCharacterEditor(props);
  if (!model.local.ready)
    return (
      <main className="mx-auto max-w-lg px-6 py-10 text-sm text-muted-foreground" role="status">
        正在恢复草稿…
      </main>
    );
  return (
    <main
      className="mx-auto w-full max-w-lg px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))]"
      onBlur={() => {
        void model.local.flush();
      }}
    >
      <CharacterEditorHeader
        editing={Boolean(props.character)}
        busy={model.busy}
        status={model.local.status}
        onBack={() => void model.goBack()}
      />
      <CharacterEditorStatus model={model} />
      <CharacterEditorCover model={model} />
      <CharacterEditorName model={model} />
      <CharacterEditorTextFields model={model} />
      <CharacterEditorOptions model={model} />
      <CharacterEditorSubmit model={model} />
      <CharacterEditorDialogHost model={model} />
    </main>
  );
}
