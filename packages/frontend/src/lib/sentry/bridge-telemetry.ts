'use client';

import * as Sentry from '@sentry/nextjs';

import { sendSentryLog, setCharacterContext } from './client';
import { recordCharacterSelectMark } from './business-navigation-telemetry';

type TrackedSpanName = 'bridge.boot';

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
  recordCharacterSelectMark(name);
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
    default:
      break;
  }
}
