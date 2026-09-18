/**
 * PostHog replay / 分析事件的 browser-safe 契约。
 * 这不是 PostHog SDK 类型，也不暴露数据库 row、凭据或消息正文。
 * `user_cohort` 本期不做，不得在此文件预留该字段。
 */
import { z } from 'zod';

import { StableModelIdSchema } from './models';
import {
  PaymentOrderStatusSchema,
  PaymentSettlementSourceSchema,
  PaymentTypeSchema,
} from './payment';

/** 聊天无操作超时。流式生成与 external_payment_pending 不计时。 */
export const REPLAY_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const TelegramUserIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9]+$/, 'telegram_user_id must be a numeric string');

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const ReplayContextIdSchema = z.string().uuid();

const NonNegativeIntSchema = z.number().int().nonnegative();

export const TELEMETRY_FORBIDDEN_PROPERTY_KEYS = [
  'content',
  'text',
  'message',
  'body',
  'pay_url',
  'payUrl',
  'initData',
  'init_data',
  'rawInitData',
  'password',
  'token',
  'secret',
  'authorization',
  'headers',
  'error_body',
  'assistant_content',
  'user_input',
  'user_cohort',
  'user_cohort_version',
] as const;

export type TelemetryForbiddenPropertyKey = (typeof TELEMETRY_FORBIDDEN_PROPERTY_KEYS)[number];

export function isForbiddenTelemetryPropertyKey(key: string): boolean {
  return (TELEMETRY_FORBIDDEN_PROPERTY_KEYS as readonly string[]).includes(key);
}

/** GET /api/telemetry/replay-context 无 query；鉴权走 Telegram header。 */
export const GetReplayContextQuerySchema = z.object({}).strict();
export type GetReplayContextQuery = z.infer<typeof GetReplayContextQuerySchema>;

export const GetReplayContextDataSchema = z
  .object({
    telegram_user_id: TelegramUserIdSchema,
    is_paid_user: z.boolean(),
    total_chat_rounds: NonNegativeIntSchema,
  })
  .strict();
export type GetReplayContextData = z.infer<typeof GetReplayContextDataSchema>;

export const ReplayChatEndReasonSchema = z.enum([
  'route_change',
  'pagehide',
  'idle_timeout',
  'unload_unknown',
]);
export type ReplayChatEndReason = z.infer<typeof ReplayChatEndReasonSchema>;

export const ChatTurnFailureKindSchema = z.enum(['business', 'network', 'timeout', 'unknown']);
export type ChatTurnFailureKind = z.infer<typeof ChatTurnFailureKindSchema>;

export const PaywallTriggerSourceSchema = z.enum([
  'chat_sse',
  'chat_voice',
  'custom_voice',
  'model_switch',
]);
export type PaywallTriggerSource = z.infer<typeof PaywallTriggerSourceSchema>;

export const PaymentReturnSurfaceSchema = z.enum(['order_detail', 'orders_list']);
export type PaymentReturnSurface = z.infer<typeof PaymentReturnSurfaceSchema>;

/** 回流是怎么被前端观察到的；不表示支付成功或失败。 */
export const PaymentReturnSourceSchema = z.enum(['start_param', 'query_param', 'webview_resume']);
export type PaymentReturnSource = z.infer<typeof PaymentReturnSourceSchema>;

export const ExternalPaymentOpenFailureKindSchema = z.enum([
  'unavailable',
  'invalid_url',
  'storage_unavailable',
]);
export type ExternalPaymentOpenFailureKind = z.infer<typeof ExternalPaymentOpenFailureKindSchema>;

export const PaymentFlowLastObservedActionSchema = z.enum([
  'paywall_triggered',
  'paywall_invite_selected',
  'paywall_recharge_selected',
  'recharge_viewed',
  'payment_method_selected',
  'payment_order_created',
  'external_payment_open_requested',
  'payment_return_observed',
  'payment_order_status_observed',
]);
export type PaymentFlowLastObservedAction = z.infer<typeof PaymentFlowLastObservedActionSchema>;

/** 用户主动点击充值入口的固定来源；本期仅个人中心余额卡。 */
export const RechargeEntrySourceSchema = z.enum(['profile_balance']);
export type RechargeEntrySource = z.infer<typeof RechargeEntrySourceSchema>;

export const ReplaySdkFailureCodeSchema = z.enum([
  'missing_config',
  'invalid_host',
  'init_failed',
  'recording_failed',
  'event_rejected',
  'network_failed',
  'context_fetch_failed',
]);
export type ReplaySdkFailureCode = z.infer<typeof ReplaySdkFailureCodeSchema>;

const OptionalUserTags = {
  is_paid_user: z.boolean().optional(),
  total_chat_rounds: NonNegativeIntSchema.optional(),
};

const ChatIdentityFields = {
  character_id: z.string().uuid(),
  conversation_session_id: z.string().uuid(),
  selected_model_id: StableModelIdSchema.nullable(),
};

const TurnFields = {
  turn_index: NonNegativeIntSchema,
  revision: z.number().int().positive(),
};

function frontendEvent<Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) {
  return z
    .object({
      event: z.literal(name),
      telegram_user_id: TelegramUserIdSchema,
      replay_context_id: ReplayContextIdSchema,
      occurred_at: IsoDateTimeSchema,
      ...OptionalUserTags,
      ...shape,
    })
    .strict();
}

export const ReplayChatStartedEventSchema = frontendEvent(
  'replay_chat_started',
  ChatIdentityFields
);
export const ReplayChatEndedEventSchema = frontendEvent('replay_chat_ended', {
  ...ChatIdentityFields,
  end_reason: ReplayChatEndReasonSchema,
});

export const ChatTurnStartedEventSchema = frontendEvent('chat_turn_started', {
  ...ChatIdentityFields,
  ...TurnFields,
});
export const ChatStreamOpenedEventSchema = frontendEvent('chat_stream_opened', {
  ...ChatIdentityFields,
  ...TurnFields,
});
export const ChatTurnCompletedEventSchema = frontendEvent('chat_turn_completed', {
  ...ChatIdentityFields,
  ...TurnFields,
  duration_ms: NonNegativeIntSchema,
});
export const ChatTurnFailedEventSchema = frontendEvent('chat_turn_failed', {
  ...ChatIdentityFields,
  ...TurnFields,
  duration_ms: NonNegativeIntSchema,
  failure_kind: ChatTurnFailureKindSchema,
});

export const ChatRegenerationRequestedEventSchema = frontendEvent('chat_regeneration_requested', {
  ...ChatIdentityFields,
  ...TurnFields,
});
export const ChatRegenerationCompletedEventSchema = frontendEvent('chat_regeneration_completed', {
  ...ChatIdentityFields,
  ...TurnFields,
  duration_ms: NonNegativeIntSchema,
});
export const ChatRegenerationFailedEventSchema = frontendEvent('chat_regeneration_failed', {
  ...ChatIdentityFields,
  ...TurnFields,
  duration_ms: NonNegativeIntSchema,
  failure_kind: ChatTurnFailureKindSchema,
});

export const PaywallTriggeredEventSchema = frontendEvent('paywall_triggered', {
  ...ChatIdentityFields,
  trigger_source: PaywallTriggerSourceSchema,
  required_credits: z.number().int().positive().optional(),
});
export const PaywallDismissedEventSchema = frontendEvent('paywall_dismissed', {
  ...ChatIdentityFields,
  trigger_source: PaywallTriggerSourceSchema,
  dwell_ms: NonNegativeIntSchema,
});
export const PaywallInviteSelectedEventSchema = frontendEvent('paywall_invite_selected', {
  ...ChatIdentityFields,
  trigger_source: PaywallTriggerSourceSchema,
  dwell_ms: NonNegativeIntSchema,
});
export const PaywallRechargeSelectedEventSchema = frontendEvent('paywall_recharge_selected', {
  ...ChatIdentityFields,
  trigger_source: PaywallTriggerSourceSchema,
  dwell_ms: NonNegativeIntSchema,
});

export const RechargeViewedEventSchema = frontendEvent('recharge_viewed', {});

/** 个人中心主动点击充值入口；允许没有 replay context，不得与 recharge_viewed 混用。 */
export const RechargeEntryClickedEventSchema = z
  .object({
    event: z.literal('recharge_entry_clicked'),
    telegram_user_id: TelegramUserIdSchema,
    occurred_at: IsoDateTimeSchema,
    replay_context_id: ReplayContextIdSchema.optional(),
    entry_source: RechargeEntrySourceSchema,
  })
  .strict();
export const PaymentMethodSelectedEventSchema = frontendEvent('payment_method_selected', {
  plan_id: z.string().trim().min(1),
  payment_type: PaymentTypeSchema,
});
export const PaymentOrderCreatedEventSchema = frontendEvent('payment_order_created', {
  plan_id: z.string().trim().min(1),
  payment_type: PaymentTypeSchema,
  order_id: z.string().trim().min(1).max(128),
  amount_cents: NonNegativeIntSchema,
});
export const ExternalPaymentOpenRequestedEventSchema = frontendEvent(
  'external_payment_open_requested',
  {
    order_id: z.string().trim().min(1).max(128),
    payment_type: PaymentTypeSchema,
    open_failure_kind: ExternalPaymentOpenFailureKindSchema.optional(),
  }
);

export const PaymentReturnObservedEventSchema = frontendEvent('payment_return_observed', {
  order_id: z.string().trim().min(1).max(128).nullable(),
  return_surface: PaymentReturnSurfaceSchema,
  payment_type: PaymentTypeSchema.optional(),
  return_source: PaymentReturnSourceSchema.optional(),
  return_route: z.string().trim().min(1).max(200).optional(),
  elapsed_ms: NonNegativeIntSchema.optional(),
});
export const PaymentOrderStatusObservedEventSchema = frontendEvent(
  'payment_order_status_observed',
  {
    order_id: z.string().trim().min(1).max(128),
    order_status: PaymentOrderStatusSchema,
    settled_by: PaymentSettlementSourceSchema.nullable(),
    elapsed_ms: NonNegativeIntSchema.optional(),
  }
);
export const PaymentFlowLeftObservedEventSchema = frontendEvent('payment_flow_left_observed', {
  order_id: z.string().trim().min(1).max(128),
  order_status: PaymentOrderStatusSchema,
  settled_by: PaymentSettlementSourceSchema.nullable(),
  last_observed_action: PaymentFlowLastObservedActionSchema,
  elapsed_ms: NonNegativeIntSchema,
});

function serverPaymentEvent<Name extends string, Shape extends z.ZodRawShape>(
  name: Name,
  shape: Shape
) {
  return z
    .object({
      event: z.literal(name),
      telegram_user_id: TelegramUserIdSchema,
      occurred_at: IsoDateTimeSchema,
      replay_context_id: ReplayContextIdSchema.optional(),
      ...shape,
    })
    .strict();
}

export const PaymentOrderSettledEventSchema = serverPaymentEvent('payment_order_settled', {
  order_id: z.string().trim().min(1).max(128),
  payment_type: PaymentTypeSchema,
  order_status: z.literal('completed'),
  settled_by: PaymentSettlementSourceSchema.nullable(),
});
export const PaymentOrderFailedEventSchema = serverPaymentEvent('payment_order_failed', {
  order_id: z.string().trim().min(1).max(128),
  payment_type: PaymentTypeSchema,
  order_status: z.literal('failed'),
  settled_by: PaymentSettlementSourceSchema.nullable(),
});

function sdkHealthEvent<Name extends string>(name: Name) {
  return z
    .object({
      event: z.literal(name),
      occurred_at: IsoDateTimeSchema,
      failure_code: ReplaySdkFailureCodeSchema,
      telegram_user_id: TelegramUserIdSchema.optional(),
      replay_context_id: ReplayContextIdSchema.optional(),
    })
    .strict();
}

export const ReplaySdkInitFailedEventSchema = sdkHealthEvent('replay_sdk_init_failed');
export const ReplayRecordingFailedEventSchema = sdkHealthEvent('replay_recording_failed');

export const ReplayTelemetryEventSchema = z.discriminatedUnion('event', [
  ReplayChatStartedEventSchema,
  ReplayChatEndedEventSchema,
  ChatTurnStartedEventSchema,
  ChatStreamOpenedEventSchema,
  ChatTurnCompletedEventSchema,
  ChatTurnFailedEventSchema,
  ChatRegenerationRequestedEventSchema,
  ChatRegenerationCompletedEventSchema,
  ChatRegenerationFailedEventSchema,
  PaywallTriggeredEventSchema,
  PaywallDismissedEventSchema,
  PaywallInviteSelectedEventSchema,
  PaywallRechargeSelectedEventSchema,
  RechargeViewedEventSchema,
  RechargeEntryClickedEventSchema,
  PaymentMethodSelectedEventSchema,
  PaymentOrderCreatedEventSchema,
  ExternalPaymentOpenRequestedEventSchema,
  PaymentReturnObservedEventSchema,
  PaymentOrderStatusObservedEventSchema,
  PaymentFlowLeftObservedEventSchema,
  PaymentOrderSettledEventSchema,
  PaymentOrderFailedEventSchema,
  ReplaySdkInitFailedEventSchema,
  ReplayRecordingFailedEventSchema,
]);

export type ReplayTelemetryEvent = z.infer<typeof ReplayTelemetryEventSchema>;
export type ReplayTelemetryEventName = ReplayTelemetryEvent['event'];

export const REPLAY_TELEMETRY_EVENT_NAMES = ReplayTelemetryEventSchema.options.map(
  (schema) => schema.shape.event.value
) as ReplayTelemetryEventName[];

export function parseGetReplayContextData(value: unknown): GetReplayContextData {
  return GetReplayContextDataSchema.parse(value);
}

export function parseReplayTelemetryEvent(value: unknown): ReplayTelemetryEvent {
  return ReplayTelemetryEventSchema.parse(value);
}
