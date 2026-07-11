import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EventName, EventPayloadMap, STMirrorState } from '@miniapp/bridge-protocol';
import type { BridgeStatus } from './state-machine';
import { getBridgeClientOrNull } from './singleton';
import { useSTMirrorStore } from '@/stores/st-mirror';

export function useBridgeStatus(): BridgeStatus {
  const subscribe = useRef((onStoreChange: () => void) => {
    const client = getBridgeClientOrNull();
    if (!client) {
      window.addEventListener('miniapp:bridge-client-ready', onStoreChange);
      return () => window.removeEventListener('miniapp:bridge-client-ready', onStoreChange);
    }
    return client.onStatusChange(onStoreChange);
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
    let unsubscribe: (() => void) | null = null;
    const subscribe = () => {
      if (unsubscribe) return;
      const client = getBridgeClientOrNull();
      if (!client) return;
      unsubscribe = client.onEvent(eventName, (payload) => {
        callbackRef.current(payload);
      });
    };

    subscribe();
    window.addEventListener('miniapp:bridge-client-ready', subscribe);
    return () => {
      window.removeEventListener('miniapp:bridge-client-ready', subscribe);
      unsubscribe?.();
    };
  }, [eventName]);
}

export function useSTMirror<T>(selector: (state: STMirrorState) => T): T {
  return useSTMirrorStore(selector);
}
