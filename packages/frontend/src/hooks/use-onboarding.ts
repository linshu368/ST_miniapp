'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOnboardingQuery } from '@/lib/api/onboarding';
import { useEntryBackgroundReady } from '@/lib/entry-phase';
import { lobbyViewerScope } from '@/lib/lobby-recommendation-state';
import { isGuideActive, useOnboardingStore, type GuideUpdate } from '@/stores/onboarding-store';

export function useOnboarding() {
  const scope = lobbyViewerScope();
  const progress = useOnboardingStore((state) => state.accounts[scope]);
  const hydrated = useOnboardingStore((state) => state.hydrated[scope]);
  const ready = useEntryBackgroundReady();
  useEffect(() => {
    useOnboardingStore.getState().hydrate(scope);
  }, [scope]);
  const query = useOnboardingQuery(scope, ready && Boolean(hydrated) && !progress);
  useEffect(() => {
    if (query.data) useOnboardingStore.getState().enroll(scope, query.data);
  }, [scope, query.data]);
  const update = useCallback(
    (patch: GuideUpdate) => {
      useOnboardingStore.getState().update(scope, patch);
    },
    [scope]
  );
  return { scope, progress, hydrated, ready, active: ready && isGuideActive(progress), update };
}

/** Do not compete with typing. No polling, viewport listeners or keyboard guesses. */
export function useGuideInputBusy() {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = () =>
      setBusy(
        Boolean(document.activeElement?.matches('input, textarea, [contenteditable="true"]'))
      );
    const onBlur = () => queueMicrotask(check);
    check();
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', onBlur);
    return () => {
      document.removeEventListener('focusin', check);
      document.removeEventListener('focusout', onBlur);
    };
  }, []);
  return busy;
}
