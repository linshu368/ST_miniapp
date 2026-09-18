import { describe, expect, it } from 'vitest';

import {
  GetReplayContextDataSchema,
  GetReplayContextQuerySchema,
  PaymentSettlementSourceSchema,
  REPLAY_IDLE_TIMEOUT_MS,
  REPLAY_TELEMETRY_EVENT_NAMES,
  ReplayTelemetryEventSchema,
  isForbiddenTelemetryPropertyKey,
  parseGetReplayContextData,
  parseReplayTelemetryEvent,
} from '../index.js';

const replayContextId = '11111111-1111-4111-8111-111111111111';
const characterId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const occurredAt = '2026-09-15T10:00:00.000Z';

const chatIdentity = {
  telegram_user_id: '123456789',
  replay_context_id: replayContextId,
  occurred_at: occurredAt,
  character_id: characterId,
  conversation_session_id: sessionId,
  selected_model_id: 'gpt-4o',
};

describe('replay context contract', () => {
  it('accepts an empty GET query', () => {
    expect(GetReplayContextQuerySchema.parse({})).toEqual({});
  });

  it('rejects unknown query fields', () => {
    expect(GetReplayContextQuerySchema.safeParse({ user_id: '1' }).success).toBe(false);
  });

  it('accepts the minimal authenticated context without user_cohort', () => {
    expect(
      parseGetReplayContextData({
        telegram_user_id: '123456789',
        is_paid_user: false,
        total_chat_rounds: 0,
      })
    ).toEqual({
      telegram_user_id: '123456789',
      is_paid_user: false,
      total_chat_rounds: 0,
    });
  });

  it('rejects user_cohort, database ids and non-numeric telegram ids', () => {
    const base = {
      telegram_user_id: '123456789',
      is_paid_user: true,
      total_chat_rounds: 12,
    };
    expect(GetReplayContextDataSchema.safeParse({ ...base, user_cohort: 'new' }).success).toBe(
      false
    );
    expect(GetReplayContextDataSchema.safeParse({ ...base, user_id: 'uuid' }).success).toBe(false);
    expect(
      GetReplayContextDataSchema.safeParse({ ...base, telegram_user_id: 'tg_abc' }).success
    ).toBe(false);
    expect(GetReplayContextDataSchema.safeParse({ ...base, total_chat_rounds: -1 }).success).toBe(
      false
    );
  });
});

describe('replay telemetry events', () => {
  it('exposes the closed event-name list from the discriminated union', () => {
    expect(REPLAY_TELEMETRY_EVENT_NAMES).toContain('replay_chat_started');
    expect(REPLAY_TELEMETRY_EVENT_NAMES).toContain('payment_order_settled');
    expect(REPLAY_TELEMETRY_EVENT_NAMES).toContain('recharge_entry_clicked');
    expect(REPLAY_TELEMETRY_EVENT_NAMES).not.toContain('user_cohort_updated');
  });

  it('records idle timeout as 15 minutes', () => {
    expect(REPLAY_IDLE_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('accepts a chat start event with optional user tags', () => {
    expect(
      parseReplayTelemetryEvent({
        event: 'replay_chat_started',
        ...chatIdentity,
        is_paid_user: true,
        total_chat_rounds: 40,
      })
    ).toMatchObject({ event: 'replay_chat_started', is_paid_user: true });
  });

  it('accepts chat end, turn failure and paywall trigger unions', () => {
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'replay_chat_ended',
        ...chatIdentity,
        end_reason: 'idle_timeout',
      }).success
    ).toBe(true);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'chat_turn_failed',
        ...chatIdentity,
        turn_index: 1,
        revision: 1,
        duration_ms: 1500,
        failure_kind: 'network',
      }).success
    ).toBe(true);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'paywall_triggered',
        ...chatIdentity,
        trigger_source: 'chat_sse',
        required_credits: 80,
      }).success
    ).toBe(true);
  });

  it('rejects unknown event names and illegal union values', () => {
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'chat_delta',
        ...chatIdentity,
      }).success
    ).toBe(false);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'replay_chat_ended',
        ...chatIdentity,
        end_reason: 'abandoned',
      }).success
    ).toBe(false);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'chat_turn_failed',
        ...chatIdentity,
        turn_index: 1,
        revision: 1,
        duration_ms: 10,
        failure_kind: 'server_500',
      }).success
    ).toBe(false);
    expect(PaymentSettlementSourceSchema.safeParse('manual').success).toBe(false);
  });

  it('rejects chat body, pay_url, initData and user_cohort on events', () => {
    const started = {
      event: 'replay_chat_started' as const,
      ...chatIdentity,
    };
    for (const key of ['content', 'pay_url', 'initData', 'user_cohort'] as const) {
      expect(isForbiddenTelemetryPropertyKey(key)).toBe(true);
      expect(ReplayTelemetryEventSchema.safeParse({ ...started, [key]: 'secret' }).success).toBe(
        false
      );
    }
  });

  it('allows server settlement events without replay_context_id', () => {
    expect(
      parseReplayTelemetryEvent({
        event: 'payment_order_settled',
        telegram_user_id: '123456789',
        occurred_at: occurredAt,
        order_id: 'MA-order-1',
        payment_type: 'wxpay',
        order_status: 'completed',
        settled_by: 'webhook',
      })
    ).toMatchObject({ settled_by: 'webhook', order_status: 'completed' });
  });

  it('accepts payment_return_observed with optional source, route, type and elapsed', () => {
    const paymentBase = {
      telegram_user_id: '123456789',
      replay_context_id: replayContextId,
      occurred_at: occurredAt,
      order_id: 'MA-order-1',
    };
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'payment_return_observed',
        ...paymentBase,
        return_surface: 'orders_list',
        payment_type: 'wxpay',
        return_source: 'webview_resume',
        return_route: '/profile/orders',
        elapsed_ms: 12_000,
      }).success
    ).toBe(true);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'payment_return_observed',
        ...paymentBase,
        return_surface: 'order_detail',
        pay_url: 'https://pay.example/checkout',
      }).success
    ).toBe(false);
  });

  it('maps nullable settled_by on observed and left events', () => {
    const paymentBase = {
      telegram_user_id: '123456789',
      replay_context_id: replayContextId,
      occurred_at: occurredAt,
      order_id: 'MA-order-1',
    };
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'payment_order_status_observed',
        ...paymentBase,
        order_status: 'pending',
        settled_by: null,
      }).success
    ).toBe(true);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        event: 'payment_order_status_observed',
        ...paymentBase,
        order_status: 'completed',
        settled_by: 'cron',
      }).success
    ).toBe(true);
  });

  it('does not require replay context for sdk health events', () => {
    expect(
      parseReplayTelemetryEvent({
        event: 'replay_sdk_init_failed',
        occurred_at: occurredAt,
        failure_code: 'missing_config',
      }).event
    ).toBe('replay_sdk_init_failed');
  });

  it('accepts recharge_entry_clicked without replay_context_id', () => {
    expect(
      parseReplayTelemetryEvent({
        event: 'recharge_entry_clicked',
        telegram_user_id: '123456789',
        occurred_at: occurredAt,
        entry_source: 'profile_balance',
      })
    ).toEqual({
      event: 'recharge_entry_clicked',
      telegram_user_id: '123456789',
      occurred_at: occurredAt,
      entry_source: 'profile_balance',
    });
  });

  it('attaches optional replay context on recharge_entry_clicked and rejects urls or pay_url', () => {
    const base = {
      event: 'recharge_entry_clicked' as const,
      telegram_user_id: '123456789',
      occurred_at: occurredAt,
      entry_source: 'profile_balance' as const,
    };
    expect(
      ReplayTelemetryEventSchema.safeParse({
        ...base,
        replay_context_id: replayContextId,
      }).success
    ).toBe(true);
    expect(ReplayTelemetryEventSchema.safeParse({ ...base, entry_source: 'lobby' }).success).toBe(
      false
    );
    expect(
      ReplayTelemetryEventSchema.safeParse({ ...base, telegram_user_id: undefined }).success
    ).toBe(false);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        ...base,
        url: 'https://app.example/profile',
      }).success
    ).toBe(false);
    expect(
      ReplayTelemetryEventSchema.safeParse({
        ...base,
        pay_url: 'https://pay.example/checkout',
      }).success
    ).toBe(false);
  });
});
