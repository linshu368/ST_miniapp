import type { ActionResultMap } from '@miniapp/bridge-protocol';
import type { BridgeServer } from '../bridge-server.js';

type Result = ActionResultMap['getReadyState'];

let _serverRef: BridgeServer | null = null;

export function setServerRef(server: BridgeServer): void {
  _serverRef = server;
}

export function handleGetReadyState(): Result {
  return { phase: _serverRef!.getCurrentPhase() };
}
