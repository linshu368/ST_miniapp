import type { BridgeClient } from './bridge-client';

let instance: BridgeClient | null = null;

export function setBridgeClient(client: BridgeClient): void {
  instance = client;
}

export function getBridgeClient(): BridgeClient {
  if (!instance) {
    throw new Error('BridgeClient not initialized. Ensure BridgeProvider is mounted.');
  }
  return instance;
}
