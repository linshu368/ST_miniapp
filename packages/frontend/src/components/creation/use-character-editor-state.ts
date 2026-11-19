'use client';

import { useCharacterWishQuery } from '@/lib/api/character-wishes';
import {
  useCreateCreatorCoverMutation,
  useCreatorCoverQuery,
  useCreatorPolishMutation,
  usePublishCreatorCharacterMutation,
  useSaveCreatorCharacterMutation,
  useSetCreatorVisibilityMutation,
} from '@/lib/api/creator-characters';
import { useCreateImagePlazaConversationMutation } from '@/lib/api/image-plaza';
import { usePageReady } from '@/lib/perf/page-ready';
import { creatorPublishMissingFields, type CreatorCharacter } from '@miniapp/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import {
  getCharacterDraftChangeState,
  initialCharacterEditorDraft,
} from './character-editor-draft';
import { useCharacterEditorDraft } from './use-character-editor-draft';

import { UUID } from './character-editor-fields';
import { useEditorInteraction } from './use-character-editor-interaction';
export type EditorProps = {
  ownerId: string;
  draftId: string;
  character?: CreatorCharacter;
  reloadCharacter: () => Promise<CreatorCharacter>;
};
export function useCharacterEditorState({
  ownerId,
  draftId,
  character,
  reloadCharacter,
}: EditorProps) {
  const router = useRouter();
  const search = useSearchParams();
  const initial = useMemo(() => initialCharacterEditorDraft(character), [character]);
  const local = useCharacterEditorDraft({ ownerId, draftId, characterId: character?.id }, initial);
  const { ready: localReady, update: updateLocal, flush: flushLocal } = local;
  usePageReady(
    character ? '/creation/characters/:id/edit' : '/creation/characters/new',
    localReady
  );
  const { draft, visibility, coverAssetId } = local.value;
  const wishParam = search.get('wish');
  const sourceWishId =
    local.value.sourceWishId ?? (wishParam && UUID.test(wishParam) ? wishParam : undefined);
  const sourceWish = useCharacterWishQuery(sourceWishId ?? undefined);
  useEffect(() => {
    if (localReady && sourceWishId && !local.value.sourceWishId)
      updateLocal((current) => ({ ...current, sourceWishId }));
  }, [localReady, sourceWishId, local.value.sourceWishId, updateLocal]);
  const editorPath = character
    ? `/creation/characters/${character.id}/edit`
    : `/creation/characters/new?draft=${draftId}`;
  const returningId = search.get('cover_asset_id');
  const requestedCover = returningId && UUID.test(returningId) ? returningId : coverAssetId;
  const cover = useCreatorCoverQuery(requestedCover);
  const coverUrl =
    cover.data?.asset.id === coverAssetId ? cover.data.asset.image_url : local.value.coverUrl;
  const upload = useCreateCreatorCoverMutation();
  const createStudio = useCreateImagePlazaConversationMutation();
  const save = useSaveCreatorCharacterMutation();
  const publish = usePublishCreatorCharacterMutation();
  const setVisibility = useSetCreatorVisibilityMutation();
  const polishMutation = useCreatorPolishMutation();
  const interaction = useEditorInteraction(draft);
  const { working, active, mounted, adoptedCover } = interaction;
  const missingFields = creatorPublishMissingFields(draft, coverAssetId);
  const busy = working || upload.isPending || createStudio.isPending;
  const publishing = visibility === 'public' && (publish.isPending || setVisibility.isPending);
  const sameContent = Boolean(
    character &&
    JSON.stringify(character.draft) === JSON.stringify(draft) &&
    character.cover_asset_id === coverAssetId
  );
  const unchanged = Boolean(
    character?.state === 'ready' &&
    sameContent &&
    character.visibility === visibility &&
    getCharacterDraftChangeState(local.value) !== 'changed'
  );
  const submitLabel =
    visibility === 'private'
      ? '保存到我的空间'
      : character?.approved_revision
        ? '发布更新'
        : '公开角色';
  useEffect(() => {
    mounted.current = true;
    return () => {
      stopCharacterEditor(active, mounted);
    };
  }, [active, mounted]);
  useEffect(() => {
    const asset = cover.data?.asset;
    if (
      !localReady ||
      !returningId ||
      !asset ||
      asset.id !== returningId ||
      adoptedCover.current === asset.id
    )
      return;
    adoptedCover.current = asset.id;
    updateLocal((current) => ({ ...current, coverAssetId: asset.id, coverUrl: asset.image_url }));
    router.replace(editorPath, { scroll: false });
  }, [cover.data, returningId, localReady, updateLocal, router, editorPath, adoptedCover]);

  return {
    ...interaction,
    ownerId,
    draftId,
    character,
    reloadCharacter,
    router,
    local,
    localReady,
    updateLocal,
    flushLocal,
    draft,
    visibility,
    coverAssetId,
    sourceWishId,
    sourceWish,
    editorPath,
    returningId,
    cover,
    coverUrl,
    upload,
    createStudio,
    save,
    publish,
    setVisibility,
    polishMutation,
    missingFields,
    busy,
    publishing,
    sameContent,
    unchanged,
    submitLabel,
  };
}
export type EditorState = ReturnType<typeof useCharacterEditorState>;

function stopCharacterEditor(
  active: { current: AbortController | null },
  mounted: { current: boolean }
) {
  mounted.current = false;
  active.current?.abort();
}
