import type {
  ExternalPaymentOpenFailureKind,
  PaymentFlowLastObservedAction,
  PaymentOrder,
  PaymentReturnSource,
  PaymentReturnSurface,
  PaymentType,
  PaywallTriggerSource,
} from '@miniapp/shared';

import { getReplayLifecycle, type ReplayEventDraft } from '@/lib/telemetry';

import {
  clearExternalPaymentPending,
  clearObservedReturnOrderIdsForTests,
  EXTERNAL_PAYMENT_PENDING_TTL_MS,
  observedOrderKey,
  persistObservedReturnOrderId,
  readExternalPaymentPending,
  readObservedReturnOrderIds,
  writeExternalPaymentPending,
  type ExternalPaymentPending,
} from './external-payment-pending';
import { readPaymentOpenMeta } from './open-storage';
import {
  patchPaywallContinuation,
  paywallDwellMs,
  readPaywallContinuation,
} from './paywall-continuation';

const statusObservedKeys = new Set<string>();
const viewedRechargeKeys = new Set<string>();
const returnObservedKeys = new Set<string>();

let memoryPending: ExternalPaymentPending | null = null;
let leftForExternalPayment = false;

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as T;
}

export function resetPaymentFlowTelemetryForTests(): void {
  statusObservedKeys.clear();
  viewedRechargeKeys.clear();
  returnObservedKeys.clear();
  memoryPending = null;
  leftForExternalPayment = false;
  clearExternalPaymentPending();
  clearObservedReturnOrderIdsForTests();
}

/** 模拟 WebView 保有 sessionStorage、但 JS 堆已丢失（刷新 / 新文档）。 */
export function forgetPaymentReturnMemoryForTests(): void {
  memoryPending = null;
  leftForExternalPayment = false;
  returnObservedKeys.clear();
}

export function retainPaywallFollowupIfActive(): void {
  const snapshot = getReplayLifecycle().getSnapshot();
  if (snapshot.state !== 'chat' && snapshot.state !== 'paywall_followup') return;
  void getReplayLifecycle().enterPaywallFollowup();
}

export function hasActiveReplayContext(): boolean {
  const snapshot = getReplayLifecycle().getSnapshot();
  if (!snapshot.replayContextId) return false;
  return (
    snapshot.state === 'chat' ||
    snapshot.state === 'paywall_followup' ||
    snapshot.state === 'external_payment_pending'
  );
}

function rememberAction(action: PaymentFlowLastObservedAction, orderId?: string): void {
  patchPaywallContinuation({
    lastObservedAction: action,
    ...(orderId ? { orderId } : {}),
  });
}

function captureDraft(draft: ReplayEventDraft): void {
  if (!hasActiveReplayContext()) return;
  getReplayLifecycle().capture(draft);
}

function paywallChatFields(): {
  trigger_source: PaywallTriggerSource;
  character_id: string;
  conversation_session_id: string;
  selected_model_id: string | null;
} | null {
  const continuation = readPaywallContinuation();
  if (
    !continuation?.triggerSource ||
    !continuation.characterId ||
    !continuation.conversationSessionId
  ) {
    return null;
  }
  return {
    trigger_source: continuation.triggerSource,
    character_id: continuation.characterId,
    conversation_session_id: continuation.conversationSessionId,
    selected_model_id: continuation.selectedModelId,
  };
}

export function captureRechargeViewed(): void {
  const snapshot = getReplayLifecycle().getSnapshot();
  const key = snapshot.replayContextId ?? '';
  if (!key || viewedRechargeKeys.has(key)) return;
  viewedRechargeKeys.add(key);
  captureDraft({ event: 'recharge_viewed' });
  rememberAction('recharge_viewed');
}

export function capturePaywallDismissed(): void {
  const fields = paywallChatFields();
  if (!fields) return;
  captureDraft({
    event: 'paywall_dismissed',
    ...fields,
    dwell_ms: paywallDwellMs(),
  });
}

export function capturePaywallInviteSelected(): void {
  const fields = paywallChatFields();
  if (!fields) return;
  captureDraft({
    event: 'paywall_invite_selected',
    ...fields,
    dwell_ms: paywallDwellMs(),
  });
  rememberAction('paywall_invite_selected');
}

export function capturePaywallRechargeSelected(): void {
  const fields = paywallChatFields();
  if (!fields) return;
  captureDraft({
    event: 'paywall_recharge_selected',
    ...fields,
    dwell_ms: paywallDwellMs(),
  });
  rememberAction('paywall_recharge_selected');
}

export function capturePaymentMethodSelected(input: {
  planId: string;
  paymentType: PaymentType;
}): void {
  captureDraft({
    event: 'payment_method_selected',
    plan_id: input.planId,
    payment_type: input.paymentType,
  });
  rememberAction('payment_method_selected');
}

export function capturePaymentOrderCreated(input: {
  planId: string;
  paymentType: PaymentType;
  orderId: string;
  amountCents: number;
}): void {
  captureDraft(
    omitUndefined({
      event: 'payment_order_created' as const,
      plan_id: input.planId,
      payment_type: input.paymentType,
      order_id: input.orderId,
      amount_cents: input.amountCents,
    })
  );
  rememberAction('payment_order_created', input.orderId);
}

export function captureExternalPaymentOpenRequested(input: {
  orderId: string;
  paymentType: PaymentType;
  openFailureKind?: ExternalPaymentOpenFailureKind;
}): void {
  captureDraft(
    omitUndefined({
      event: 'external_payment_open_requested' as const,
      order_id: input.orderId,
      payment_type: input.paymentType,
      open_failure_kind: input.openFailureKind,
    })
  );
  rememberAction('external_payment_open_requested', input.orderId);
}

export type MarkExternalPaymentOpenedInput = {
  orderId: string;
  paymentType: PaymentType;
  now?: number;
};

/**
 * 必须在 openPaymentUrl 之前调用。Telegram openLink 可能同步把 WebView
 * 切到 hidden；若先打开再记账，回流监听会错过这次离开。
 */
export function markExternalPaymentOpened(input: MarkExternalPaymentOpenedInput): void {
  const orderId = input.orderId.trim();
  if (!orderId) return;
  memoryPending = {
    orderId,
    paymentType: input.paymentType,
    replayContextId: getReplayLifecycle().getSnapshot().replayContextId,
    openedAt: input.now ?? Date.now(),
  };
  leftForExternalPayment = false;
  writeExternalPaymentPending(memoryPending);
}

export function noteExternalPaymentBackgrounded(now: number = Date.now()): void {
  if (!readPendingReturn(now)) return;
  leftForExternalPayment = true;
}

export type ObservePaymentReturnInput = {
  source: PaymentReturnSource;
  orderId?: string | null;
  route?: string;
  now?: number;
};

/**
 * 只表示前端看到用户回到 MiniApp，不表示支付成功、失败或放弃。
 * WebView 恢复路径必须先有打开外部支付的 pending，并且曾经切到后台，
 * 避免 VPN 弹窗 focus / 普通前后台切换误报。
 */
export function observePaymentReturn(input: ObservePaymentReturnInput): boolean {
  const now = input.now ?? Date.now();
  const pending = readPendingReturn(now);
  const explicit = input.source === 'start_param' || input.source === 'query_param';
  if (!explicit) {
    if (!pending || !leftForExternalPayment) return false;
  }

  const orderId = resolveReturnOrderId(input.orderId, pending);
  if (hasObservedReturn(orderId)) return false;
  if (!hasActiveReplayContext()) return false;

  const route = safePaymentReturnRoute(input.route ?? currentPathname());
  const matchingPending =
    pending && (orderId === null || pending.orderId === orderId) ? pending : null;
  rememberObservedReturn(orderId);
  captureDraft(
    omitUndefined({
      event: 'payment_return_observed' as const,
      order_id: orderId,
      return_surface: surfaceFromRoute(route),
      payment_type: matchingPending?.paymentType,
      return_source: input.source,
      return_route: route,
      elapsed_ms: matchingPending ? Math.max(0, now - matchingPending.openedAt) : undefined,
    })
  );
  rememberAction('payment_return_observed', orderId ?? undefined);
  clearPendingReturn();
  return true;
}

function readPendingReturn(now: number): ExternalPaymentPending | null {
  const candidate = memoryPending ?? readExternalPaymentPending(now);
  if (!candidate) return null;
  if (now - candidate.openedAt > EXTERNAL_PAYMENT_PENDING_TTL_MS) {
    clearPendingReturn();
    return null;
  }
  memoryPending = candidate;
  return candidate;
}

function clearPendingReturn(): void {
  memoryPending = null;
  leftForExternalPayment = false;
  clearExternalPaymentPending();
}

function resolveReturnOrderId(
  explicitOrderId: string | null | undefined,
  pending: ExternalPaymentPending | null
): string | null {
  const explicit = explicitOrderId?.trim() || null;
  if (explicit) return explicit;
  return pending?.orderId ?? readPaywallContinuation()?.orderId ?? null;
}

function hasObservedReturn(orderId: string | null): boolean {
  const key = observedOrderKey(orderId);
  if (returnObservedKeys.has(key)) return true;
  for (const stored of readObservedReturnOrderIds()) {
    returnObservedKeys.add(stored);
  }
  return returnObservedKeys.has(key);
}

function rememberObservedReturn(orderId: string | null): void {
  returnObservedKeys.add(observedOrderKey(orderId));
  persistObservedReturnOrderId(orderId);
}

function surfaceFromRoute(pathname: string): PaymentReturnSurface {
  if (pathname === '/profile/orders' || pathname.startsWith('/profile/orders/')) {
    return 'orders_list';
  }
  return 'order_detail';
}

function currentPathname(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname;
}

export function safePaymentReturnRoute(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '/';
  try {
    const url = new URL(trimmed, 'https://miniapp.local');
    return (url.pathname || '/').slice(0, 200);
  } catch {
    const path = trimmed.split('?')[0]?.split('#')[0] ?? '/';
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return normalized.slice(0, 200) || '/';
  }
}

export function capturePaymentOrderStatusObserved(order: PaymentOrder): void {
  const key = `${order.id}:${order.status}:${String(order.settled_by)}`;
  if (statusObservedKeys.has(key)) return;
  statusObservedKeys.add(key);
  const elapsed = Number.isFinite(Date.parse(order.created_at))
    ? Math.max(0, Date.now() - Date.parse(order.created_at))
    : undefined;
  captureDraft(
    omitUndefined({
      event: 'payment_order_status_observed' as const,
      order_id: order.id,
      order_status: order.status,
      settled_by: order.settled_by,
      elapsed_ms: elapsed,
    })
  );
  rememberAction('payment_order_status_observed', order.id);
}

export function capturePaymentFlowLeftObserved(order: PaymentOrder): void {
  const continuation = readPaywallContinuation();
  const meta = readPaymentOpenMeta(order.id);
  const lastObservedAction = continuation?.lastObservedAction ?? 'payment_order_status_observed';
  const startedAt = meta?.createdAt ?? continuation?.startedAt ?? Date.parse(order.created_at);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
  captureDraft({
    event: 'payment_flow_left_observed',
    order_id: order.id,
    order_status: order.status,
    settled_by: order.settled_by,
    last_observed_action: lastObservedAction,
    elapsed_ms: elapsedMs,
  });
}
