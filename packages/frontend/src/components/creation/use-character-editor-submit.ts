'use client';

import { ApiClientError } from '@/lib/api/client';
import { createUuid } from '@/lib/uuid';
import { CharacterDraftSchema, CREATOR_REVIEW_REJECTED_CODE } from '@miniapp/shared';
import { initialCharacterEditorDraft, saveCharacterDraft } from './character-editor-draft';

import type { EditorState } from './use-character-editor-state';
export function useEditorRecovery(model: EditorState) {
  const {
    ownerId,
    draftId,
    character,
    reloadCharacter,
    local,
    setNotice,
    setWorking,
    setRecoveryOpen,
    setRecoveryDraftId,
    backupId,
    setSession,
    sessionRef,
    setPolishOpen,
    active,
    busyRef,
    mounted,
  } = model;
  async function loadLatestKeepingBackup() {
    if (!character || busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    setNotice('');
    try {
      active.current?.abort();
      active.current = null;
      const id = backupId.current ?? (backupId.current = createUuid());
      await saveCharacterDraft(
        { ownerId, draftId: id },
        {
          ...local.value,
          serverRevision: null,
          baselineFingerprint: undefined,
          recoveryFor: character.id,
        }
      );
      setRecoveryDraftId(id);
      const fresh = await reloadCharacter();
      if (!mounted.current) return;
      if (!(await local.replace(initialCharacterEditorDraft(fresh))))
        throw new Error('最新版暂未载入，当前修改和备份都已保留，请重试。');
      setRecoveryOpen(false);
      setSession(null);
      sessionRef.current = null;
      setPolishOpen(false);
      backupId.current = null;
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '修改没保存成功，现在的内容没变，再试一次吧。'
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return { loadLatestKeepingBackup };
}

export function useEditorSubmit(model: EditorState, focusMissing: (label: string) => void) {
  const {
    draftId,
    character,
    router,
    local,
    draft,
    visibility,
    coverAssetId,
    sourceWishId,
    save,
    publish,
    setVisibility,
    missingFields,
    publishing,
    sameContent,
    unchanged,
    setNotice,
    setWorking,
    busyRef,
    mounted,
  } = model;
  async function submit() {
    if (busyRef.current || unchanged) return;
    setNotice('');
    if (missingFields.length) {
      focusMissing(missingFields[0]!);
      return;
    }
    const parsed = CharacterDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setNotice('内容超出可保存范围，请检查名称、正文和导入文件的长度。');
      return;
    }
    if (local.conflict) {
      setNotice('这张角色卡已有更新，请先载入最新版本。你的本地内容仍然保留。');
      return;
    }
    busyRef.current = true;
    setWorking(true);
    try {
      let publishedDestination = '/creation?tab=created';
      if (sameContent && character?.state === 'ready' && character.visibility !== visibility) {
        await setVisibility.mutateAsync({
          id: character.id,
          body: {
            expected_revision: local.value.serverRevision ?? character.revision,
            visibility,
          },
        });
      } else {
        const saved =
          local.value.serverRevision !== null
            ? await save.mutateAsync({
                id: character?.id ?? draftId,
                body: {
                  expected_revision: local.value.serverRevision,
                  draft: parsed.data,
                  cover_asset_id: coverAssetId,
                },
              })
            : await save.mutateAsync({
                body: { id: draftId, draft: parsed.data, cover_asset_id: coverAssetId },
              });
        // A retried create can return its original record; bring it up to the current local content before publishing.
        const current =
          JSON.stringify(saved.character.draft) === JSON.stringify(parsed.data) &&
          saved.character.cover_asset_id === coverAssetId
            ? saved.character
            : (
                await save.mutateAsync({
                  id: saved.character.id,
                  body: {
                    expected_revision: saved.character.revision,
                    draft: parsed.data,
                    cover_asset_id: coverAssetId,
                  },
                })
              ).character;
        local.update((value) => ({ ...value, serverRevision: current.revision }));
        await local.flush();
        const published = await publish.mutateAsync({
          id: current.id,
          body: {
            expected_revision: current.revision,
            visibility,
            ...(sourceWishId ? { wish_id: sourceWishId } : {}),
          },
        });
        if (published.wish_response) {
          const response = published.wish_response;
          publishedDestination = `/wishes/${response.wish_id}${response.status === 'not_linked' ? `?respond=${current.id}` : ''}`;
        }
      }
      await local.clear();
      router.replace(publishedDestination);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        local.setConflict(true);
        setNotice('这张角色卡已有更新，请载入最新版本后继续。当前内容已保留在本地。');
      } else if (error instanceof ApiClientError && error.code === CREATOR_REVIEW_REJECTED_CODE) {
        setNotice(`未通过审核：${error.message}`);
      } else
        setNotice(error instanceof Error ? error.message : '保存未完成，请重试。你的内容已保留。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return { submit };
}
