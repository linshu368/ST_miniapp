'use client';

import { useTelegramBackButton } from '@/lib/telegram/hooks';
import { type CharacterDraft } from '@miniapp/shared';
import { useCallback } from 'react';
import { dismissTopCharacterEditorModal } from './character-editor-dialogs';

import { useEditorCoverActions } from './use-character-editor-cover';
import { useEditorPolish } from './use-character-editor-polish';
import type { EditorState } from './use-character-editor-state';
import { useCharacterEditorState, type EditorProps } from './use-character-editor-state';
import { useEditorRecovery, useEditorSubmit } from './use-character-editor-submit';
import { useEditorValidation } from './use-character-editor-validation';
export function useEditorNavigation(model: EditorState) {
  const { router, local, flushLocal, draft, sourceWishId, setNotice, busyRef } = model;
  const goBack = useCallback(async () => {
    if (dismissTopCharacterEditorModal() || busyRef.current) return;
    if (!(await flushLocal())) {
      setNotice('本地草稿还没保存成功，请稍后再返回。当前内容仍在这里。');
      return;
    }
    router.push(sourceWishId ? `/wishes/${sourceWishId}` : '/creation?tab=created');
  }, [flushLocal, router, sourceWishId, busyRef, setNotice]);
  useTelegramBackButton(goBack);
  const change = (
    key: keyof Pick<CharacterDraft, 'name' | 'description' | 'opening' | 'background' | 'preset'>,
    value: string
  ) => local.update((current) => ({ ...current, draft: { ...current.draft, [key]: value } }));

  return { goBack, change };
}
export function useCharacterEditor(props: EditorProps) {
  const state = useCharacterEditorState(props);
  const navigation = useEditorNavigation(state);
  const cover = useEditorCoverActions(state);
  const polish = useEditorPolish(state);
  const validation = useEditorValidation(state);
  const recovery = useEditorRecovery(state);
  const submit = useEditorSubmit(state, validation.focusMissing);
  return { ...state, ...navigation, ...cover, ...polish, ...validation, ...recovery, ...submit };
}
export type EditorModel = ReturnType<typeof useCharacterEditor>;
