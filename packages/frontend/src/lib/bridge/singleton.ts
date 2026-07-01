import type { BridgeClient } from './bridge-client';

let instance: BridgeClient | null = null;

export function setBridgeClient(client: BridgeClient): void {
  instance = client;
  if (typeof window !== 'undefined') {
    (window as unknown as { __bridge?: BridgeClient }).__bridge = client;
    window.dispatchEvent(new Event('miniapp:bridge-client-ready'));
  }
}

export function getBridgeClient(): BridgeClient {
  if (!instance) {
    throw new Error('BridgeClient not initialized. Ensure BridgeProvider is mounted.');
  }
  return instance;
}

export function getBridgeClientOrNull(): BridgeClient | null {
  return instance;
}
