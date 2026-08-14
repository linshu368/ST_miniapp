import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import type { BridgeServer } from './bridge-server.js';
import './st-types.js';

type ControlPayload = ActionPayloadMap['presetPreflightControl'];
type ControlResult = ActionResultMap['presetPreflightControl'];
type PreflightOutcome = Extract<ControlPayload, { operation: 'complete' }>['outcome'];

const PREFLIGHT_TIMEOUT_MS = 10_000;
const POINTER_PREFIX = 'platform_';

interface PendingPreflight {
  timer: number;
  resolve: (outcome: PreflightOutcome) => void;
}

const pendingPreflights = new Map<string, PendingPreflight>();
let frontendReady = false;

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `preflight-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function finishPreflight(requestId: string, outcome: PreflightOutcome): boolean {
  const pending = pendingPreflights.get(requestId);
  if (!pending) return false;
  window.clearTimeout(pending.timer);
  pendingPreflights.delete(requestId);
  pending.resolve(outcome);
  return true;
}

function finishAllPreflights(): void {
  for (const requestId of [...pendingPreflights.keys()]) {
    finishPreflight(requestId, 'failed');
  }
}

export function handlePresetPreflightControl(payload: ControlPayload): ControlResult {
  if (payload.operation === 'set-ready') {
    frontendReady = payload.ready;
    if (!frontendReady) finishAllPreflights();
    return { accepted: true };
  }
  return { accepted: finishPreflight(payload.requestId, payload.outcome) };
}

export function installPresetPreflight(server: BridgeServer): void {
  const ctx = SillyTavern.getContext();

  ctx.eventSource.makeFirst(
    ctx.eventTypes.GENERATION_STARTED,
    async (_type: string, _options: unknown, dryRun: boolean) => {
      if (dryRun || !frontendReady || server.getCurrentPhase() !== 'ready') return;

      const requestId = createRequestId();
      const settings = ctx.chatCompletionSettings as Record<string, unknown>;
      const pointer = settings.preset_settings_openai;
      const currentPresetPointer =
        typeof pointer === 'string' && pointer.startsWith(POINTER_PREFIX) ? pointer : null;
      const currentModel = ctx.getChatCompletionModel();

      const outcome = await new Promise<PreflightOutcome>((resolve) => {
        const timer = window.setTimeout(() => {
          pendingPreflights.delete(requestId);
          resolve('failed');
        }, PREFLIGHT_TIMEOUT_MS);
        pendingPreflights.set(requestId, { timer, resolve });
        server.sendEvent('preset:preflight-requested', {
          requestId,
          currentModel: currentModel || null,
          currentPresetPointer,
        });
      });

      if (outcome === 'failed') {
        console.warn('[PresetPreflight] latest preset check failed; using last known good preset');
      }
    }
  );
}
