'use client';

import { validateImagePlazaReference } from '@/lib/api/image-plaza';
import { prepareCoverImage } from '@/lib/utils/cover-image';
import { createUuid } from '@/lib/uuid';

import type { EditorState } from './use-character-editor-state';
export function useEditorCoverActions(model: EditorState) {
  const {
    router,
    local,
    coverAssetId,
    editorPath,
    coverUrl,
    upload,
    createStudio,
    setCoverError,
    setWorking,
    busyRef,
    mounted,
  } = model;
  async function uploadCover(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    setCoverError('');
    try {
      validateImagePlazaReference(file);
      const payload = await prepareCoverImage(file);
      const { asset } = await upload.mutateAsync({
        id: createUuid(),
        source: 'upload',
        ...payload,
      });
      if (!mounted.current) return;
      local.update((current) => ({
        ...current,
        coverAssetId: asset.id,
        coverUrl: asset.image_url,
      }));
    } catch (error) {
      if (mounted.current)
        setCoverError(error instanceof Error ? error.message : '封面上传失败，请重试。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function generateCover() {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    setCoverError('');
    try {
      if (!(await local.flush())) throw new Error('本地草稿暂未保存，请稍后再进入图片创作。');
      let studioId = local.value.coverStudioId;
      if (!studioId) {
        const data = await createStudio.mutateAsync({});
        if (!mounted.current) return;
        studioId = data.conversation.id;
        local.update((current) => ({ ...current, coverStudioId: studioId }));
        if (!(await local.flush())) throw new Error('生成记录暂未保存，请稍后再试。');
      }
      if (!mounted.current) return;
      router.push(`/create/studio/${studioId}?creator_return=${encodeURIComponent(editorPath)}`);
    } catch (error) {
      if (mounted.current)
        setCoverError(error instanceof Error ? error.message : '没能进入图片创作，再试一次吧。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return { uploadCover, generateCover };
}
