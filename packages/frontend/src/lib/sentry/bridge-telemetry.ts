'use client';

import * as Sentry from '@sentry/nextjs';

import { sendSentryLog, setCharacterContext } from './client';

type TrackedSpanName =
  | 'bridge.boot'
  | 'tavern.open'
  | 'tavern.ensure_character'
  | 'tavern.select_character';

const activeSpans = new Map<TrackedSpanName, Sentry.Span>();
let activeCharacterId: string | undefined;

function spanAttributes(): Record<string, string> {
  return activeCharacterId ? { character_id: activeCharacterId } : {};
}

function startTrackedSpan(name: TrackedSpanName, op: string): void {
  if (!Sentry.getClient()) return;

  const previous = activeSpans.get(name);
  if (previous) {
    previous.setAttribute('result', 'restarted');
    previous.end();
  }

  activeSpans.set(
    name,
    Sentry.startInactiveSpan({
      name,
      op,
      forceTransaction: true,
      attributes: spanAttributes(),
    })
  );
}

function endTrackedSpan(name: TrackedSpanName, result: string): void {
  const span = activeSpans.get(name);
  if (!span) return;
  span.setAttribute('result', result);
  if (activeCharacterId) span.setAttribute('character_id', activeCharacterId);
  span.end();
  activeSpans.delete(name);
}

function logBridgeResult(
  level: 'info' | 'warn' | 'error',
  eventName: string,
  result: string
): void {
  sendSentryLog(level, eventName, {
    ...(activeCharacterId ? { characterId: activeCharacterId } : {}),
    result,
  });
}

export function setBridgeTelemetryCharacter(characterId: string): void {
  activeCharacterId = characterId;
  setCharacterContext(characterId);
}

export function cancelTavernTelemetry(): void {
  endTrackedSpan('tavern.ensure_character', 'cancelled');
  endTrackedSpan('tavern.select_character', 'cancelled');
  endTrackedSpan('tavern.open', 'cancelled');
}

export function recordBridgeRecoveryOutcome(
  outcome: 'recovered' | 'disconnected',
  counts: { bootFatalCount: number; nukeReloadCount: number; reloadCount: number }
): void {
  if (outcome === 'disconnected') {
    endTrackedSpan('bridge.boot', 'disconnected');
  }
  sendSentryLog(
    outcome === 'recovered' ? 'info' : 'error',
    outcome === 'recovered' ? 'bridge.recovered' : 'bridge.disconnected',
    {
      result: outcome,
      bootFatalCount: counts.bootFatalCount,
      nukeReloadCount: counts.nukeReloadCount,
      reloadCount: counts.reloadCount,
    }
  );
}

export function recordBridgeActionFailure(
  action: string,
  requestId: string,
  code: string,
  durationMs: number
): void {
  sendSentryLog('error', 'bridge.action_failed', {
    action,
    requestId,
    result: code,
    durationMs,
    ...(activeCharacterId ? { characterId: activeCharacterId } : {}),
  });
}

/**
 * Mirrors the existing iframe timing milestones into Sentry while the temporary
 * debug POST remains in place for side-by-side validation.
 */
export function recordBridgeTelemetryMark(name: string, detail?: string): void {
  switch (name) {
    case 'bridge_start':
      startTrackedSpan('bridge.boot', 'bridge.boot');
      break;
    case 'st_ready':
      endTrackedSpan('bridge.boot', 'ready');
      break;
    case 'boot_fatal':
      endTrackedSpan('bridge.boot', 'fatal');
      logBridgeResult('error', 'bridge.boot_fatal', detail ?? 'fatal');
      break;
    case 'page_mount':
      startTrackedSpan('tavern.open', 'ui.load');
      break;
    case 'chat_ready':
      endTrackedSpan('tavern.open', 'ready');
      logBridgeResult('info', 'tavern.chat_ready', 'ready');
      break;
    case 'ensure_start':
      startTrackedSpan('tavern.ensure_character', 'bridge.action');
      break;
    case 'ensure_end':
      endTrackedSpan('tavern.ensure_character', detail ? 'error' : 'success');
      if (detail) logBridgeResult('error', 'tavern.ensure_character_failed', detail);
      break;
    case 'select_start':
      startTrackedSpan('tavern.select_character', 'bridge.action');
      break;
    case 'select_end':
      endTrackedSpan('tavern.select_character', 'success');
      break;
    case 'select_error':
      endTrackedSpan('tavern.select_character', 'error');
      endTrackedSpan('tavern.open', 'select_error');
      logBridgeResult('error', 'tavern.select_character_failed', detail ?? 'select_error');
      break;
    case 'gate_stall':
      logBridgeResult('warn', 'tavern.gate_stall', 'stalled');
      break;
    case 'select_stall':
      logBridgeResult('warn', 'tavern.select_stall', 'stalled');
      break;
    default:
      break;
  }
}
