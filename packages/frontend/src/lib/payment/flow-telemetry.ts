import type {
  ExternalPaymentOpenFailureKind,
  PaymentFlowLastObservedAction,
  PaymentOrder,
  PaymentReturnSurface,
  PaymentType,
  PaywallTriggerSource,
} from '@miniapp/shared';

import { getReplayLifecycle, type ReplayEventDraft } from '@/lib/telemetry';

import { readPaymentOpenMeta } from './open-storage';
import {
  patchPaywallContinuation,
  paywallDwellMs,
  readPaywallContinuation,
} from './paywall-continuation';

const statusObservedKeys = new Set<string>();
const returnObservedKeys = new Set<string>();
const viewedRechargeKeys = new Set<string>();

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as T;
}

export function resetPaymentFlowTelemetryForTests(): void {
  statusObservedKeys.clear();
  returnObservedKeys.clear();
  viewedRechargeKeys.clear();
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

export function capturePaymentReturnObserved(input: {
  orderId: string | null;
  surface: PaymentReturnSurface;
  onceKey: string;
}): void {
  const key = `${input.onceKey}:${input.orderId ?? ''}:${input.surface}`;
  if (returnObservedKeys.has(key)) return;
  returnObservedKeys.add(key);
  captureDraft({
    event: 'payment_return_observed',
    order_id: input.orderId,
    return_surface: input.surface,
  });
  rememberAction('payment_return_observed', input.orderId ?? undefined);
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
