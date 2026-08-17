'use client';

import * as Sentry from '@sentry/nextjs';

import { sendSentryLog, type SentryLogAttributes } from './client';

export type FirstChatEntrySource = 'gallery' | 'history' | 'favorites' | 'direct' | 'retry';
export type FirstChatResult =
  | 'success'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'replaced_by_retry'
  | 'timed_out';

type SpanKey =
  | 'route'
  | 'wait_gate'
  | 'prepare'
  | 'ensure'
  | 'latest_chat'
  | 'select'
  | 'character_resolve'
  | 'select_by_id'
  | 'new_chat'
  | 'open_chat'
  | 'fallback_select'
  | 'render';

type FirstChatAttempt = {
  journeyId: string;
  attemptId: string;
  attemptNumber: number;
  characterId: string;
  source: FirstChatEntrySource;
  startedAt: number;
  root: Sentry.Span;
  spans: Map<SpanKey, Sentry.Span>;
  spanStartedAt: Map<SpanKey, number>;
  stageDurations: Partial<Record<SpanKey, number>>;
  degraded: boolean;
  stallCount: number;
  ended: boolean;
  timeoutId: number;
};

type BeginOptions = {
  bridgePhase?: string;
  bootElapsedMs?: number;
  reuseJourney?: boolean;
};

const COMPLETED_KEY = 'miniapp:first-chat-completed';
const JOURNEY_KEY = 'miniapp:first-chat-journey';
const HARD_TIMEOUT_MS = 90_000;

let currentAttempt: FirstChatAttempt | undefined;
let attemptSequence = 0;

function randomId(prefix: string): string {
  const value =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${value}`;
}

function storageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Telemetry must never block navigation.
  }
}

function storageDelete(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Telemetry must never block navigation.
  }
}

function hasCompletedFirstChat(): boolean {
  return storageGet(COMPLETED_KEY) === '1';
}

function startChildSpan(
  attempt: FirstChatAttempt,
  key: SpanKey,
  name: string,
  op: string,
  attributes: Record<string, string | number | boolean> = {}
): Sentry.Span | undefined {
  if (attempt.ended || attempt.spans.has(key)) return attempt.spans.get(key);

  const parent =
    key === 'ensure' || key === 'latest_chat'
      ? (attempt.spans.get('prepare') ?? attempt.root)
      : key === 'character_resolve' || key === 'select_by_id' || key === 'new_chat'
        ? (attempt.spans.get('select') ?? attempt.root)
        : attempt.root;
  let span: Sentry.Span | undefined;
  Sentry.withActiveSpan(parent, () => {
    span = Sentry.startInactiveSpan({
      name,
      op,
      attributes: {
        service: 'frontend',
        journey_id: attempt.journeyId,
        attempt_id: attempt.attemptId,
        character_id: attempt.characterId,
        ...attributes,
      },
    });
  });
  if (span) attempt.spans.set(key, span);
  if (span) attempt.spanStartedAt.set(key, Date.now());
  return span;
}

function endSpan(
  attempt: FirstChatAttempt,
  key: SpanKey,
  result: string,
  attributes: Record<string, string | number | boolean> = {}
): void {
  const span = attempt.spans.get(key);
  if (!span) return;
  span.setAttribute('result', result);
  for (const [name, value] of Object.entries(attributes)) span.setAttribute(name, value);
  span.end();
  attempt.spans.delete(key);
  const startedAt = attempt.spanStartedAt.get(key);
  if (startedAt !== undefined) attempt.stageDurations[key] = Date.now() - startedAt;
  attempt.spanStartedAt.delete(key);
}

function finishAttempt(attempt: FirstChatAttempt, result: FirstChatResult, reason?: string): void {
  if (attempt.ended) return;
  attempt.ended = true;
  window.clearTimeout(attempt.timeoutId);

  for (const [key, span] of attempt.spans) {
    span.setAttribute('result', result);
    span.setAttribute('ended_early', true);
    span.end();
    attempt.spans.delete(key);
    const startedAt = attempt.spanStartedAt.get(key);
    if (startedAt !== undefined) attempt.stageDurations[key] = Date.now() - startedAt;
    attempt.spanStartedAt.delete(key);
  }

  const elapsedMs = Date.now() - attempt.startedAt;
  const finalResult =
    result === 'success' && attempt.degraded ? ('degraded' satisfies FirstChatResult) : result;
  attempt.root.setAttribute('result', finalResult);
  attempt.root.setAttribute('duration_ms', elapsedMs);
  attempt.root.setAttribute('stall_count', attempt.stallCount);
  if (reason) attempt.root.setAttribute('reason', reason);
  attempt.root.end();

  const attributes: SentryLogAttributes = {
    service: 'frontend',
    stage: 'first_chat',
    result: finalResult,
    journeyId: attempt.journeyId,
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    characterId: attempt.characterId,
    durationMs: elapsedMs,
    stallCount: attempt.stallCount,
    routeDurationMs: attempt.stageDurations.route,
    waitGateDurationMs: attempt.stageDurations.wait_gate,
    prepareDurationMs: attempt.stageDurations.prepare,
    ensureDurationMs: attempt.stageDurations.ensure,
    latestChatDurationMs: attempt.stageDurations.latest_chat,
    selectDurationMs: attempt.stageDurations.select,
    openChatDurationMs: attempt.stageDurations.open_chat,
    fallbackSelectDurationMs: attempt.stageDurations.fallback_select,
    renderDurationMs: attempt.stageDurations.render,
    ...(reason ? { reason } : {}),
  };
  const level =
    finalResult === 'failed' || finalResult === 'timed_out'
      ? 'error'
      : finalResult === 'degraded'
        ? 'warn'
        : 'info';
  sendSentryLog(
    level,
    finalResult === 'success' || finalResult === 'degraded'
      ? 'tavern.first_chat.completed'
      : finalResult === 'cancelled' || finalResult === 'replaced_by_retry'
        ? 'tavern.first_chat.cancelled'
        : 'tavern.first_chat.failed',
    attributes
  );

  if (finalResult === 'success' || finalResult === 'degraded') {
    storageSet(COMPLETED_KEY, '1');
    storageDelete(JOURNEY_KEY);
  }
  if (currentAttempt?.attemptId === attempt.attemptId) currentAttempt = undefined;
}

export function beginFirstChatNavigation(
  characterId: string,
  source: FirstChatEntrySource,
  options: BeginOptions = {}
): string | undefined {
  if (!Sentry.getClient() || hasCompletedFirstChat()) return undefined;

  if (currentAttempt && !currentAttempt.ended) {
    if (currentAttempt.characterId === characterId && source !== 'retry') {
      return currentAttempt.attemptId;
    }
    finishAttempt(
      currentAttempt,
      source === 'retry' ? 'replaced_by_retry' : 'cancelled',
      source === 'retry' ? 'user_retry' : 'new_navigation'
    );
  }

  const storedJourney = options.reuseJourney ? storageGet(JOURNEY_KEY) : null;
  const journeyId = storedJourney ?? randomId('journey');
  storageSet(JOURNEY_KEY, journeyId);
  attemptSequence += 1;
  const attemptId = randomId('attempt');
  const attemptNumber = attemptSequence;
  const attributes: Record<string, string | number | boolean> = {
    service: 'frontend',
    journey_id: journeyId,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    character_id: characterId,
    entry_source: source,
    is_first_chat: true,
    ...(options.bridgePhase ? { bridge_phase_at_click: options.bridgePhase } : {}),
    ...(options.bootElapsedMs !== undefined
      ? { boot_elapsed_ms_at_click: options.bootElapsedMs }
      : {}),
  };
  const root = Sentry.startInactiveSpan({
    name: 'tavern.first_chat_open',
    op: 'ui.load',
    forceTransaction: true,
    attributes,
  });
  const attempt: FirstChatAttempt = {
    journeyId,
    attemptId,
    attemptNumber,
    characterId,
    source,
    startedAt: Date.now(),
    root,
    spans: new Map(),
    spanStartedAt: new Map(),
    stageDurations: {},
    degraded: false,
    stallCount: 0,
    ended: false,
    timeoutId: 0,
  };
  attempt.timeoutId = window.setTimeout(() => {
    finishAttempt(attempt, 'timed_out', 'hard_timeout');
  }, HARD_TIMEOUT_MS);
  currentAttempt = attempt;
  startChildSpan(attempt, 'route', 'ui.route_transition', 'ui.navigation');
  sendSentryLog('info', 'tavern.first_chat.started', {
    service: 'frontend',
    stage: 'navigation',
    result: 'started',
    journeyId,
    attemptId,
    attemptNumber,
    characterId,
    entrySource: source,
  });
  return attemptId;
}

export function mountFirstChatAttempt(
  characterId: string,
  bridgePhase: string,
  bootElapsedMs?: number
): string | undefined {
  const attemptId =
    currentAttempt?.characterId === characterId
      ? currentAttempt.attemptId
      : beginFirstChatNavigation(characterId, 'direct', {
          bridgePhase,
          bootElapsedMs,
          reuseJourney: true,
        });
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return undefined;

  attempt.root.setAttribute('bridge_phase_at_mount', bridgePhase);
  if (bootElapsedMs !== undefined)
    attempt.root.setAttribute('boot_elapsed_ms_at_mount', bootElapsedMs);
  endSpan(attempt, 'route', 'mounted');
  startChildSpan(attempt, 'wait_gate', 'bridge.wait_gate', 'bridge.wait');
  return attempt.attemptId;
}

export function recordFirstChatGateOpen(attemptId: string | undefined, phase: string): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  endSpan(attempt, 'wait_gate', 'opened', { bridge_phase: phase });
  startChildSpan(attempt, 'prepare', 'chat.prepare', 'chat.prepare');
  sendSentryLog('info', 'tavern.gate.opened', {
    service: 'frontend',
    stage: 'wait_gate',
    result: 'opened',
    journeyId: attempt.journeyId,
    attemptId,
    characterId: attempt.characterId,
    bridgePhase: phase,
    elapsedMs: Date.now() - attempt.startedAt,
  });
}

export async function traceFirstChatOperation<T>(
  attemptId: string | undefined,
  key: Extract<SpanKey, 'ensure' | 'latest_chat' | 'select' | 'open_chat' | 'fallback_select'>,
  name: string,
  op: string,
  operation: () => Promise<T>
): Promise<T> {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return operation();
  const span = startChildSpan(attempt, key, name, op);
  if (!span) return operation();
  try {
    const result = await Sentry.withActiveSpan(span, operation);
    endSpan(attempt, key, 'success');
    return result;
  } catch (error) {
    endSpan(attempt, key, 'error');
    throw error;
  }
}

export function finishFirstChatPrepare(attemptId: string | undefined): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  endSpan(attempt, 'prepare', 'ready');
}

export function recordFirstChatSelectMark(name: string): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.ended) return;
  switch (name) {
    case 'sel_start':
      startChildSpan(attempt, 'character_resolve', 'bridge.character_resolve', 'bridge.action');
      break;
    case 'sel_reload_done':
      endSpan(attempt, 'character_resolve', 'success');
      startChildSpan(attempt, 'select_by_id', 'bridge.select_by_id', 'bridge.action');
      break;
    case 'sel_selectById_done':
      endSpan(attempt, 'select_by_id', 'success');
      startChildSpan(attempt, 'new_chat', 'bridge.new_chat_or_clear', 'bridge.action');
      break;
    case 'sel_newchat_done':
      endSpan(attempt, 'new_chat', 'success');
      break;
    case 'sel_newchat_error':
      endSpan(attempt, 'new_chat', 'error');
      break;
    default:
      break;
  }
}

export function startFirstChatRender(attemptId: string | undefined): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  startChildSpan(attempt, 'render', 'ui.render_chat', 'ui.render');
}

export function completeFirstChatAfterPaint(attemptId: string | undefined): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  endSpan(attempt, 'render', 'visible');
  finishAttempt(attempt, 'success');
}

export function markFirstChatDegraded(
  attemptId: string | undefined,
  reason: 'ensure_failed' | 'open_chat_fallback'
): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  attempt.degraded = true;
  attempt.root.setAttribute(`degraded.${reason}`, true);
}

export function recordFirstChatStall(
  attemptId: string | undefined,
  stage: 'gate' | 'select',
  bridgePhase: string
): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  attempt.stallCount += 1;
  attempt.root.setAttribute('stall_observed', true);
  attempt.root.setAttribute('stall_count', attempt.stallCount);
  const key: SpanKey = stage === 'gate' ? 'wait_gate' : 'select';
  attempt.spans.get(key)?.setAttribute('stall_observed', true);
  sendSentryLog('warn', `tavern.${stage}.stalled`, {
    service: 'frontend',
    stage: stage === 'gate' ? 'wait_gate' : 'select_character',
    result: 'stalled',
    journeyId: attempt.journeyId,
    attemptId,
    characterId: attempt.characterId,
    bridgePhase,
    elapsedMs: Date.now() - attempt.startedAt,
  });
}

export function failFirstChatAttempt(
  attemptId: string | undefined,
  reason: string,
  error?: unknown
): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  if (error instanceof Error) {
    Sentry.withScope((scope) => {
      scope.setTag('service', 'frontend');
      scope.setTag('attempt_id', attempt.attemptId);
      scope.setTag('character_id', attempt.characterId);
      scope.setContext('first_chat', {
        journeyId: attempt.journeyId,
        attemptId: attempt.attemptId,
        stage: reason,
      });
      Sentry.captureException(error);
    });
  }
  finishAttempt(attempt, 'failed', reason);
}

export function cancelFirstChatAttempt(attemptId: string | undefined, reason: string): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.attemptId !== attemptId || attempt.ended) return;
  finishAttempt(attempt, 'cancelled', reason);
}

export function retryFirstChatAttempt(
  characterId: string,
  bridgePhase: string,
  bootElapsedMs?: number
): string | undefined {
  return beginFirstChatNavigation(characterId, 'retry', {
    bridgePhase,
    bootElapsedMs,
    reuseJourney: true,
  });
}

export function getFirstChatCorrelation(): {
  journeyId: string;
  attemptId: string;
} | null {
  const attempt = currentAttempt;
  if (!attempt || attempt.ended) return null;
  return { journeyId: attempt.journeyId, attemptId: attempt.attemptId };
}
