'use client';

import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';

import { useReplayContextQuery } from '@/lib/api/telemetry';

import { getReplayLifecycle } from './lifecycle';

export function ReplayLifecycleOwner() {
  const lifecycle = getReplayLifecycle();
  const snapshot = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot
  );
  const recordingActive =
    snapshot.state === 'chat' ||
    snapshot.state === 'paywall_followup' ||
    snapshot.state === 'external_payment_pending';
  const query = useReplayContextQuery(snapshot.telemetryReady && recordingActive);

  useEffect(() => {
    lifecycle.attachWindowListeners();
    return () => {
      lifecycle.detachWindowListeners();
    };
  }, [lifecycle]);

  useEffect(() => {
    if (query.data) lifecycle.applyUserTags(query.data);
  }, [lifecycle, query.data]);

  useEffect(() => {
    if (query.isError) lifecycle.reportContextFetchFailed();
  }, [lifecycle, query.isError]);

  return null;
}
