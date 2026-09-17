'use client';

import { useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

import { useReplayContextQuery } from '@/lib/api/telemetry';

import { getReplayLifecycle } from './lifecycle';

export function ReplayLifecycleOwner() {
  const lifecycle = getReplayLifecycle();
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const snapshot = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
    lifecycle.getSnapshot
  );
  const recordingActive =
    snapshot.state === 'chat' ||
    snapshot.state === 'recharge' ||
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
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    if (
      !pathname.startsWith('/profile/recharge') &&
      !pathname.startsWith('/profile/orders') &&
      lifecycle.isStandaloneRecharge()
    ) {
      void lifecycle.endReplay('route_change');
    }
  }, [lifecycle, pathname]);

  useEffect(() => {
    if (query.data) lifecycle.applyUserTags(query.data);
  }, [lifecycle, query.data]);

  useEffect(() => {
    if (query.isError) lifecycle.reportContextFetchFailed();
  }, [lifecycle, query.isError]);

  return null;
}
