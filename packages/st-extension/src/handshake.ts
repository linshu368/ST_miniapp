import { actionRegistry, eventRegistry } from '@miniapp/bridge-protocol';
import type { HandshakeMeta } from '@miniapp/bridge-protocol';
import type { BridgeServer } from './bridge-server.js';
import { setBoundUserId } from './mirror-state.js';
import './st-types.js';

declare const __BUILD_ID__: string;
declare const __ST_COMMIT__: string;

export interface HandshakeOptions {
  buildId: string;
  stCommit: string;
}

/**
 * Initialize two-phase handshake:
 * 1. Immediately send handshake(phase='handshake') with meta
 * 2. Listen for ST APP_READY event → send handshake(phase='ready')
 */
export function initHandshake(server: BridgeServer, opts: HandshakeOptions): void {
  const ctx = SillyTavern.getContext();

  // 不确定：accountStorage 机制在 multi-user 环境中是否可靠，
  // 可能需要降级为读 cookie
  const boundUserId = ctx.accountStorage?.currentUser?.id ?? null;

  if (boundUserId) {
    setBoundUserId(boundUserId);
  }

  const meta: HandshakeMeta = {
    stCommit: opts.stCommit,
    extensionBuildId: opts.buildId,
    supportedActions: Object.keys(actionRegistry),
    supportedEvents: Object.keys(eventRegistry),
    boundUserId,
  };

  server.sendHandshake('handshake', meta);

  ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    server.setCurrentPhase('ready');
    server.sendHandshake('ready');
  });
}
