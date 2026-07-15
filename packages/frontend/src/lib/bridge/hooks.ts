import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EventName, EventPayloadMap, STMirrorState } from '@miniapp/bridge-protocol';
import type { BridgeStatus } from './state-machine';
import { getBridgeClient, getBridgeClientOrNull } from './singleton';
import { useSTMirrorStore } from '@/stores/st-mirror';

export function useBridgeStatus(): BridgeStatus {
  const subscribe = useRef((onStoreChange: () => void) => {
    let unsubscribeClient: (() => void) | null = null;

    const subscribeClient = () => {
      if (unsubscribeClient) return;
      const client = getBridgeClientOrNull();
      if (!client) return;

      unsubscribeClient = client.onStatusChange(onStoreChange);
      // setBridgeClient() fires before client.start(); re-read the current idle state now,
      // then onStatusChange will deliver loading/interactive/ready transitions.
      onStoreChange();
    };

    subscribeClient();
    window.addEventListener('miniapp:bridge-client-ready', subscribeClient);

    return () => {
      window.removeEventListener('miniapp:bridge-client-ready', subscribeClient);
      unsubscribeClient?.();
    };
  }).current;

  const getSnapshot = useRef(() => {
    const client = getBridgeClientOrNull();
    return client?.getStatus() ?? 'idle';
  }).current;

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSTEvent<E extends EventName>(
  eventName: E,
  callback: (payload: EventPayloadMap[E]) => void
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const client = getBridgeClient();
    const unsub = client.onEvent(eventName, (payload) => {
      callbackRef.current(payload);
    });
    return unsub;
  }, [eventName]);
}

export function useSTMirror<T>(selector: (state: STMirrorState) => T): T {
  return useSTMirrorStore(selector);
}
