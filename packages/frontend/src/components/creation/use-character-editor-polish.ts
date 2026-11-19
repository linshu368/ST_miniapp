'use client';

import { CreatorPolishRequestSchema } from '@miniapp/shared';
import {
  type CharacterPolishSession,
  type CharacterPolishTarget,
} from './character-editor-dialogs';

import type { EditorState } from './use-character-editor-state';
export function usePolishRetention(model: EditorState) {
  const { local, setSession, sessionRef, setPolishOpen, active } = model;
  function keepPolish(next: CharacterPolishSession) {
    sessionRef.current = next;
    setSession(next);
    local.update((current) => ({
      ...current,
      polishCandidates: { ...current.polishCandidates, [next.target]: next },
    }));
  }
  const closePolish = () => {
    setPolishOpen(false);
    void local.flush();
  };
  function discardPolish() {
    const current = sessionRef.current;
    if (!current) return;
    local.update((value) => {
      const candidates = { ...value.polishCandidates };
      delete candidates[current.target];
      return { ...value, polishCandidates: candidates };
    });
    sessionRef.current = null;
    setSession(null);
    setPolishOpen(false);
    void local.flush();
  }
  function stopPolish() {
    const current = sessionRef.current;
    if (current?.state !== 'loading') return;
    // Detach first so a late stream event cannot overwrite the retained text.
    const controller = active.current;
    active.current = null;
    controller?.abort();
    if (!current.result.trim()) {
      discardPolish();
      return;
    }
    keepPolish({ ...current, state: 'stopped' });
    void local.flush();
  }
  return { keepPolish, closePolish, discardPolish, stopPolish };
}

export function useEditorPolish(model: EditorState) {
  const {
    local,
    draft,
    polishMutation,
    setSession,
    sessionRef,
    setPolishOpen,
    setPolishFeedback,
    active,
    polishSnapshot,
    mounted,
  } = model;
  const retention = usePolishRetention(model);
  const { keepPolish } = retention;
  async function polish(target: CharacterPolishTarget, retry = false) {
    if (!retry) {
      const candidate =
        active.current && sessionRef.current?.target === target
          ? sessionRef.current
          : local.value.polishCandidates[target];
      if (candidate) {
        sessionRef.current = candidate;
        setSession(candidate);
        setPolishOpen(true);
        polishSnapshot.current = draft;
        return;
      }
    }
    if (active.current && sessionRef.current?.target !== target) return;
    const context = retry ? polishSnapshot.current : draft;
    const parsed = CreatorPolishRequestSchema.safeParse({ target, draft: context });
    if (!parsed.success) {
      setPolishFeedback((current) => ({
        ...current,
        [target]: parsed.error.issues[0]?.message || '先写几句想法，再让 AI 帮你完善。',
      }));
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    polishSnapshot.current = context;
    keepPolish({ target, original: context[target], result: '', state: 'loading', error: '' });
    setPolishOpen(true);
    try {
      await polishMutation.mutateAsync({
        body: parsed.data,
        signal: controller.signal,
        onText: (text) => {
          if (mounted.current && active.current === controller && sessionRef.current)
            keepPolish({ ...sessionRef.current, result: text });
        },
      });
      if (mounted.current && active.current === controller && sessionRef.current)
        keepPolish({ ...sessionRef.current, state: 'ready' });
    } catch (error) {
      if (
        mounted.current &&
        active.current === controller &&
        !controller.signal.aborted &&
        sessionRef.current
      )
        keepPolish({
          ...sessionRef.current,
          state: 'error',
          error: error instanceof Error ? error.message : '润色暂时未完成。原稿已保留。',
        });
    } finally {
      if (active.current === controller) active.current = null;
      void local.flush();
    }
  }

  return { ...retention, polish };
}
