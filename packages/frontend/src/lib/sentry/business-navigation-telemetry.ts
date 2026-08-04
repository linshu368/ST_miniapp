'use client';

import * as Sentry from '@sentry/nextjs';

import { getActiveBootSessionId } from '@/lib/bridge/boot-session';

import { sendSentryLog } from './client';

export type CharacterEntrySource = 'gallery' | 'history' | 'favorites' | 'direct';
type BusinessNavigationAction = 'character_open' | 'chat_list_open';
type BusinessNavigationResult = 'success' | 'failed' | 'cancelled' | 'deadline_exceeded';
type PhaseKey = 'click_to_navigation' | 'navigation_to_data' | 'data_to_ui_ready';

type BusinessNavigationAttempt = {
  action: BusinessNavigationAction;
  attemptId: string;
  journeyId?: string;
  characterId?: string;
  isFirstChat: boolean;
  bootSessionId?: string;
  startedAt: number;
  root: Sentry.Span;
  phases: Map<PhaseKey, Sentry.Span>;
  operations: Set<Sentry.Span>;
  detailSpans: Map<string, Sentry.Span>;
  degraded: boolean;
  stallCount: number;
  retryCount: number;
  retryableErrorCount: number;
  ended: boolean;
  timeoutId: number;
};

type BeginOptions = {
  pageFrom: string;
  navigationType: 'link' | 'push' | 'direct';
  characterId?: string;
  entrySource?: CharacterEntrySource;
  bridgePhase?: string;
  bootElapsedMs?: number;
};

const ACTION_CONFIG: Record<
  BusinessNavigationAction,
  {
    transactionName: string;
    businessAction: string;
    pageTo: string;
    readyCondition: string;
  }
> = {
  character_open: {
    transactionName: 'business.character_open',
    businessAction: '点击角色',
    pageTo: '角色页',
    readyCondition: '对话遮罩消失且核心内容可交互',
  },
  chat_list_open: {
    transactionName: 'business.chat_list_open',
    businessAction: '点击聊天',
    pageTo: '会话列表',
    readyCondition: '历史会话请求完成且列表或空态完成绘制',
  },
};

const COMPLETED_FIRST_CHAT_KEY = 'miniapp:first-chat-completed';
const FIRST_CHAT_JOURNEY_KEY = 'miniapp:first-chat-journey';
const HARD_TIMEOUT_MS = 90_000;

let currentAttempt: BusinessNavigationAttempt | undefined;

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
  return storageGet(COMPLETED_FIRST_CHAT_KEY) === '1';
}

function startPhase(attempt: BusinessNavigationAttempt, key: PhaseKey): void {
  if (attempt.ended || attempt.phases.has(key)) return;
  let span: Sentry.Span | undefined;
  Sentry.withActiveSpan(attempt.root, () => {
    span = Sentry.startInactiveSpan({
      name: key,
      op: key === 'data_to_ui_ready' ? 'ui.render' : 'ui.navigation',
      attributes: {
        'business.action': ACTION_CONFIG[attempt.action].businessAction,
        attempt_id: attempt.attemptId,
      },
    });
  });
  if (span) attempt.phases.set(key, span);
}

function endPhase(attempt: BusinessNavigationAttempt, key: PhaseKey, result: string): void {
  const span = attempt.phases.get(key);
  if (!span) return;
  span.setAttribute('result', result);
  span.end();
  attempt.phases.delete(key);
}

function startDetailSpan(
  attempt: BusinessNavigationAttempt,
  key: string,
  name: string,
  op: string
): void {
  if (attempt.ended || attempt.detailSpans.has(key)) return;
  let span: Sentry.Span | undefined;
  Sentry.withActiveSpan(attempt.root, () => {
    span = Sentry.startInactiveSpan({
      name,
      op,
      attributes: {
        attempt_id: attempt.attemptId,
        ...(attempt.characterId ? { character_id: attempt.characterId } : {}),
      },
    });
  });
  if (span) attempt.detailSpans.set(key, span);
}

function endDetailSpan(attempt: BusinessNavigationAttempt, key: string, result: string): void {
  const span = attempt.detailSpans.get(key);
  if (!span) return;
  span.setAttribute('result', result);
  span.end();
  attempt.detailSpans.delete(key);
}

function finishAttempt(
  attempt: BusinessNavigationAttempt,
  result: BusinessNavigationResult,
  reason?: string
): void {
  if (attempt.ended) return;
  attempt.ended = true;
  window.clearTimeout(attempt.timeoutId);

  for (const span of [
    ...attempt.phases.values(),
    ...attempt.operations.values(),
    ...attempt.detailSpans.values(),
  ]) {
    span.setAttribute('result', result);
    span.setAttribute('ended_early', true);
    span.end();
  }
  attempt.phases.clear();
  attempt.operations.clear();
  attempt.detailSpans.clear();

  const elapsedMs = Date.now() - attempt.startedAt;
  attempt.root.setAttribute('result', result);
  attempt.root.setAttribute('duration_ms', elapsedMs);
  attempt.root.setAttribute('degraded', attempt.degraded);
  attempt.root.setAttribute('stall_count', attempt.stallCount);
  attempt.root.setAttribute('retry_count', attempt.retryCount);
  attempt.root.setAttribute('retryable_error_count', attempt.retryableErrorCount);
  if (reason) attempt.root.setAttribute('reason', reason);
  attempt.root.end();

  if (attempt.isFirstChat) {
    const logResult = result === 'success' && attempt.degraded ? 'degraded' : result;
    const level =
      result === 'failed' || result === 'deadline_exceeded'
        ? 'error'
        : attempt.degraded
          ? 'warn'
          : 'info';
    sendSentryLog(
      level,
      result === 'success'
        ? 'tavern.first_chat.completed'
        : result === 'cancelled'
          ? 'tavern.first_chat.cancelled'
          : 'tavern.first_chat.failed',
      {
        service: 'frontend',
        stage: 'first_chat',
        result: logResult,
        journeyId: attempt.journeyId,
        attemptId: attempt.attemptId,
        characterId: attempt.characterId,
        bootSessionId: attempt.bootSessionId,
        durationMs: elapsedMs,
        stallCount: attempt.stallCount,
        retryCount: attempt.retryCount,
        ...(reason ? { reason } : {}),
      }
    );
    if (result === 'success') {
      storageSet(COMPLETED_FIRST_CHAT_KEY, '1');
      storageDelete(FIRST_CHAT_JOURNEY_KEY);
    }
  }

  if (currentAttempt?.attemptId === attempt.attemptId) currentAttempt = undefined;
}

function getAttempt(attemptId: string | undefined): BusinessNavigationAttempt | undefined {
  if (!attemptId || currentAttempt?.attemptId !== attemptId || currentAttempt.ended) {
    return undefined;
  }
  return currentAttempt;
}

function beginNavigation(
  action: BusinessNavigationAction,
  options: BeginOptions
): string | undefined {
  if (!Sentry.getClient()) return undefined;
  if (currentAttempt && !currentAttempt.ended) {
    finishAttempt(currentAttempt, 'cancelled', 'replaced_by_navigation');
  }

  const isFirstChat = action === 'character_open' && !hasCompletedFirstChat();
  const journeyId = isFirstChat
    ? (storageGet(FIRST_CHAT_JOURNEY_KEY) ?? randomId('journey'))
    : undefined;
  if (journeyId) storageSet(FIRST_CHAT_JOURNEY_KEY, journeyId);
  const bootSessionId = action === 'character_open' ? getActiveBootSessionId() : undefined;
  const config = ACTION_CONFIG[action];
  const attemptId = randomId('business');
  const root = Sentry.startInactiveSpan({
    name: config.transactionName,
    op: 'ui.load',
    forceTransaction: true,
    attributes: {
      service: 'frontend',
      attempt_id: attemptId,
      'business.action': config.businessAction,
      'page.from': options.pageFrom,
      'page.to': config.pageTo,
      'navigation.type': options.navigationType,
      'ready.condition': config.readyCondition,
      result: 'started',
      ...(options.characterId ? { character_id: options.characterId } : {}),
      ...(options.entrySource ? { entry_source: options.entrySource } : {}),
      ...(isFirstChat ? { is_first_chat: true, journey_id: journeyId ?? '' } : {}),
      ...(bootSessionId ? { boot_session_id: bootSessionId } : {}),
      ...(options.bridgePhase ? { bridge_phase_at_click: options.bridgePhase } : {}),
      ...(options.bootElapsedMs !== undefined
        ? { boot_elapsed_ms_at_click: options.bootElapsedMs }
        : {}),
    },
  });
  const attempt: BusinessNavigationAttempt = {
    action,
    attemptId,
    journeyId,
    characterId: options.characterId,
    isFirstChat,
    bootSessionId,
    startedAt: Date.now(),
    root,
    phases: new Map(),
    operations: new Set(),
    detailSpans: new Map(),
    degraded: false,
    stallCount: 0,
    retryCount: 0,
    retryableErrorCount: 0,
    ended: false,
    timeoutId: 0,
  };
  attempt.timeoutId = window.setTimeout(() => {
    finishAttempt(attempt, 'deadline_exceeded', 'hard_timeout');
  }, HARD_TIMEOUT_MS);
  currentAttempt = attempt;
  startPhase(attempt, 'click_to_navigation');

  if (isFirstChat) {
    sendSentryLog('info', 'tavern.first_chat.started', {
      service: 'frontend',
      stage: 'navigation',
      result: 'started',
      journeyId,
      attemptId,
      characterId: options.characterId,
      entrySource: options.entrySource,
    });
  }
  return attemptId;
}

function markNavigationStarted(attemptId: string | undefined): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  endPhase(attempt, 'click_to_navigation', 'started');
  startPhase(attempt, 'navigation_to_data');
}

export function getBusinessPageName(pathname: string | null): string {
  if (!pathname || pathname === '/') return '首页';
  if (pathname.startsWith('/tavern/')) return '角色页';
  if (pathname.startsWith('/chats')) return '会话列表';
  if (pathname.startsWith('/profile')) return '个人中心';
  if (pathname.startsWith('/create')) return '创作页';
  return '其他页面';
}

export function beginCharacterNavigation(
  characterId: string,
  source: Exclude<CharacterEntrySource, 'direct'>,
  options: {
    pageFrom: string;
    navigationType: 'link' | 'push';
    bridgePhase: string;
    bootElapsedMs?: number;
  }
): string | undefined {
  const attemptId = beginNavigation('character_open', {
    ...options,
    characterId,
    entrySource: source,
  });
  markNavigationStarted(attemptId);
  return attemptId;
}

export function beginChatListNavigation(pageFrom: string): string | undefined {
  const attemptId = beginNavigation('chat_list_open', {
    pageFrom,
    navigationType: 'link',
  });
  markNavigationStarted(attemptId);
  return attemptId;
}

export function mountCharacterNavigation(
  characterId: string,
  bridgePhase: string,
  bootElapsedMs?: number
): string | undefined {
  let attempt = currentAttempt;
  if (
    !attempt ||
    attempt.action !== 'character_open' ||
    attempt.characterId !== characterId ||
    attempt.ended
  ) {
    if (hasCompletedFirstChat()) return undefined;
    const attemptId = beginNavigation('character_open', {
      pageFrom: '外部直达',
      navigationType: 'direct',
      characterId,
      entrySource: 'direct',
      bridgePhase,
      bootElapsedMs,
    });
    markNavigationStarted(attemptId);
    attempt = getAttempt(attemptId);
  }
  if (!attempt) return undefined;

  attempt.root.setAttribute('route_mounted_ms', Date.now() - attempt.startedAt);
  attempt.root.setAttribute('bridge_phase_at_mount', bridgePhase);
  if (bootElapsedMs !== undefined) {
    attempt.root.setAttribute('boot_elapsed_ms_at_mount', bootElapsedMs);
  }
  startDetailSpan(attempt, 'wait_gate', 'bridge.wait_gate', 'bridge.wait');
  return attempt.attemptId;
}

export function mountChatListNavigation(): string | undefined {
  const attempt = currentAttempt;
  if (!attempt || attempt.action !== 'chat_list_open' || attempt.ended) return undefined;
  attempt.root.setAttribute('route_mounted_ms', Date.now() - attempt.startedAt);
  return attempt.attemptId;
}

export function recordCharacterGateOpen(attemptId: string | undefined, bridgePhase: string): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  endDetailSpan(attempt, 'wait_gate', 'opened');
  attempt.root.setAttribute('bridge_phase_at_gate', bridgePhase);
}

export function completeBusinessNavigationData(attemptId: string | undefined): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  endPhase(attempt, 'navigation_to_data', 'success');
  startPhase(attempt, 'data_to_ui_ready');
}

export async function traceBusinessNavigationOperation<T>(
  attemptId: string | undefined,
  name: string,
  op: string,
  operation: () => Promise<T>
): Promise<T> {
  const attempt = getAttempt(attemptId);
  if (!attempt) return operation();

  const parent = attempt.phases.get('navigation_to_data') ?? attempt.root;
  let span: Sentry.Span | undefined;
  Sentry.withActiveSpan(parent, () => {
    span = Sentry.startInactiveSpan({
      name,
      op,
      attributes: {
        'business.action': ACTION_CONFIG[attempt.action].businessAction,
        attempt_id: attempt.attemptId,
      },
    });
  });
  if (!span) return operation();

  attempt.operations.add(span);
  try {
    const result = await Sentry.withActiveSpan(span, operation);
    if (attempt.operations.delete(span)) {
      span.setAttribute('result', 'success');
      span.end();
    }
    return result;
  } catch (error) {
    if (attempt.operations.delete(span)) {
      span.setAttribute('result', 'error');
      span.end();
    }
    throw error;
  }
}

export function completeBusinessNavigation(attemptId: string | undefined): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  endPhase(attempt, 'data_to_ui_ready', 'success');
  finishAttempt(attempt, 'success');
}

export function markBusinessNavigationDegraded(
  attemptId: string | undefined,
  reason: 'ensure_failed' | 'open_chat_fallback'
): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  attempt.degraded = true;
  attempt.root.setAttribute(`degraded.${reason}`, true);
}

export function recordBusinessNavigationRetryableFailure(
  attemptId: string | undefined,
  reason: string,
  error?: unknown
): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  attempt.retryableErrorCount += 1;
  attempt.root.setAttribute('retry_pending', true);
  attempt.root.setAttribute('retryable_error_count', attempt.retryableErrorCount);
  attempt.root.setAttribute('last_retryable_error', reason);
  if (error instanceof Error) {
    Sentry.withScope((scope) => {
      scope.setTag('service', 'frontend');
      scope.setTag('attempt_id', attempt.attemptId);
      if (attempt.characterId) scope.setTag('character_id', attempt.characterId);
      scope.setContext('business_navigation', {
        action: attempt.action,
        attemptId: attempt.attemptId,
        journeyId: attempt.journeyId,
        stage: reason,
      });
      Sentry.captureException(error);
    });
  }
}

export function recordBusinessNavigationRetry(attemptId: string | undefined): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  attempt.retryCount += 1;
  attempt.root.setAttribute('retry_pending', false);
  attempt.root.setAttribute('retry_count', attempt.retryCount);
}

export function recordBusinessNavigationStall(
  attemptId: string | undefined,
  stage: 'gate' | 'select',
  bridgePhase: string
): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  attempt.stallCount += 1;
  attempt.root.setAttribute('stall_observed', true);
  attempt.root.setAttribute('stall_count', attempt.stallCount);
  sendSentryLog('warn', `tavern.${stage}.stalled`, {
    service: 'frontend',
    stage: stage === 'gate' ? 'wait_gate' : 'select_character',
    result: 'stalled',
    journeyId: attempt.journeyId,
    attemptId: attempt.attemptId,
    characterId: attempt.characterId,
    bridgePhase,
    elapsedMs: Date.now() - attempt.startedAt,
  });
}

export function recordCharacterSelectMark(name: string): void {
  const attempt = currentAttempt;
  if (!attempt || attempt.action !== 'character_open' || attempt.ended) return;
  switch (name) {
    case 'sel_start':
      startDetailSpan(attempt, 'character_resolve', 'bridge.character_resolve', 'bridge.action');
      break;
    case 'sel_reload_done':
      endDetailSpan(attempt, 'character_resolve', 'success');
      startDetailSpan(attempt, 'select_by_id', 'bridge.select_by_id', 'bridge.action');
      break;
    case 'sel_selectById_done':
      endDetailSpan(attempt, 'select_by_id', 'success');
      startDetailSpan(attempt, 'new_chat', 'bridge.new_chat_or_clear', 'bridge.action');
      break;
    case 'sel_newchat_done':
      endDetailSpan(attempt, 'new_chat', 'success');
      break;
    case 'sel_newchat_error':
      endDetailSpan(attempt, 'new_chat', 'error');
      break;
    default:
      break;
  }
}

export function failBusinessNavigation(attemptId: string | undefined, reason: string): void {
  const attempt = getAttempt(attemptId);
  if (attempt) finishAttempt(attempt, 'failed', reason);
}

export function cancelBusinessNavigation(attemptId: string | undefined, reason: string): void {
  const attempt = getAttempt(attemptId);
  if (attempt) finishAttempt(attempt, 'cancelled', reason);
}

export function getFirstChatCorrelation(): {
  journeyId: string;
  attemptId: string;
} | null {
  const attempt = currentAttempt;
  if (!attempt || attempt.ended || !attempt.isFirstChat || !attempt.journeyId) return null;
  return { journeyId: attempt.journeyId, attemptId: attempt.attemptId };
}
