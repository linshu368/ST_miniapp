import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EventName, EventPayloadMap, STMirrorState } from '@miniapp/bridge-protocol';
import type { BridgeStatus } from './state-machine';
import { getBridgeClient } from './singleton';
import { useSTMirrorStore } from '@/stores/st-mirror';

export function useBridgeStatus(): BridgeStatus {
  const subscribe = useRef((onStoreChange: () => void) => {
    const client = getBridgeClient();
    return client.onStatusChange(onStoreChange);
  }).current;

  const getSnapshot = useRef(() => {
    const client = getBridgeClient();
    return client.getStatus();
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
