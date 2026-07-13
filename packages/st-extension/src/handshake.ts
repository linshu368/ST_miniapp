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

function dismissForegroundBootSplash(): void {
  const splash = document.getElementById('miniapp-boot-splash');
  if (!splash) return;

  splash.classList.add('is-dismissing');
  window.setTimeout(() => {
    splash.remove();
    document.documentElement.classList.remove('miniapp-foreground-boot');
  }, 240);
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
    dismissForegroundBootSplash();
    if (!boundUserId) {
      const retryUserId = ctx.accountStorage?.currentUser?.id ?? null;
      if (retryUserId) {
        setBoundUserId(retryUserId);
      }
    }
    server.setCurrentPhase('ready');
    server.sendHandshake('ready');

    // 静默触发自动进行 ST LLM API 状态连接
    setTimeout(() => {
      const btn = document.getElementById('api_button_openai');
      if (btn) btn.click();
    }, 500);
  });
}
