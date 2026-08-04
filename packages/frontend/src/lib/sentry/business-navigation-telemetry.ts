'use client';

import * as Sentry from '@sentry/nextjs';

export type BusinessNavigationAction = 'character_open' | 'chat_list_open';
export type BusinessNavigationResult = 'success' | 'failed' | 'cancelled' | 'deadline_exceeded';

type PhaseKey = 'click_to_navigation' | 'navigation_to_data' | 'data_to_ui_ready';

type BusinessNavigationAttempt = {
  action: BusinessNavigationAction;
  attemptId: string;
  startedAt: number;
  root: Sentry.Span;
  phases: Map<PhaseKey, Sentry.Span>;
  operations: Set<Sentry.Span>;
  ended: boolean;
  timeoutId: number;
};

type BeginOptions = {
  pageFrom: string;
  navigationType: 'link' | 'push';
  attributes?: Record<string, string | number | boolean>;
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

const HARD_TIMEOUT_MS = 90_000;

let currentAttempt: BusinessNavigationAttempt | undefined;

function randomAttemptId(): string {
  const value =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `business_${value}`;
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

function finishAttempt(
  attempt: BusinessNavigationAttempt,
  result: BusinessNavigationResult,
  reason?: string
): void {
  if (attempt.ended) return;
  attempt.ended = true;
  window.clearTimeout(attempt.timeoutId);

  for (const [key, span] of attempt.phases) {
    span.setAttribute('result', result);
    span.setAttribute('ended_early', true);
    span.end();
    attempt.phases.delete(key);
  }
  for (const span of attempt.operations) {
    span.setAttribute('result', result);
    span.setAttribute('ended_early', true);
    span.end();
    attempt.operations.delete(span);
  }

  attempt.root.setAttribute('result', result);
  attempt.root.setAttribute('duration_ms', Date.now() - attempt.startedAt);
  if (reason) attempt.root.setAttribute('reason', reason);
  attempt.root.end();

  if (currentAttempt?.attemptId === attempt.attemptId) currentAttempt = undefined;
}

function getAttempt(attemptId: string | undefined): BusinessNavigationAttempt | undefined {
  if (!attemptId || currentAttempt?.attemptId !== attemptId || currentAttempt.ended) {
    return undefined;
  }
  return currentAttempt;
}

export function getBusinessPageName(pathname: string | null): string {
  if (!pathname || pathname === '/') return '首页';
  if (pathname.startsWith('/tavern/')) return '角色页';
  if (pathname.startsWith('/chats')) return '会话列表';
  if (pathname.startsWith('/profile')) return '个人中心';
  if (pathname.startsWith('/create')) return '创作页';
  return '其他页面';
}

export function beginBusinessNavigation(
  action: BusinessNavigationAction,
  options: BeginOptions
): string | undefined {
  if (!Sentry.getClient()) return undefined;

  if (currentAttempt && !currentAttempt.ended) {
    finishAttempt(currentAttempt, 'cancelled', 'replaced_by_navigation');
  }

  const config = ACTION_CONFIG[action];
  const attemptId = randomAttemptId();
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
      ...options.attributes,
    },
  });
  const attempt: BusinessNavigationAttempt = {
    action,
    attemptId,
    startedAt: Date.now(),
    root,
    phases: new Map(),
    operations: new Set(),
    ended: false,
    timeoutId: 0,
  };
  attempt.timeoutId = window.setTimeout(() => {
    finishAttempt(attempt, 'deadline_exceeded', 'hard_timeout');
  }, HARD_TIMEOUT_MS);
  currentAttempt = attempt;
  startPhase(attempt, 'click_to_navigation');
  return attemptId;
}

export function markBusinessNavigationStarted(attemptId: string | undefined): void {
  const attempt = getAttempt(attemptId);
  if (!attempt) return;
  endPhase(attempt, 'click_to_navigation', 'started');
  startPhase(attempt, 'navigation_to_data');
}

export function mountBusinessNavigation(action: BusinessNavigationAction): string | undefined {
  const attempt = currentAttempt;
  if (!attempt || attempt.action !== action || attempt.ended) return undefined;
  attempt.root.setAttribute('route_mounted_ms', Date.now() - attempt.startedAt);
  return attempt.attemptId;
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

export function failBusinessNavigation(attemptId: string | undefined, reason: string): void {
  const attempt = getAttempt(attemptId);
  if (attempt) finishAttempt(attempt, 'failed', reason);
}

export function cancelBusinessNavigation(attemptId: string | undefined, reason: string): void {
  const attempt = getAttempt(attemptId);
  if (attempt) finishAttempt(attempt, 'cancelled', reason);
}
