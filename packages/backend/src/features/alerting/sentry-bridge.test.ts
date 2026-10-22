import { describe, expect, it } from 'vitest';
import { AlertEvaluationSchema } from '@miniapp/shared';

import { convertSentryAlert } from './sentry-bridge.js';

const ctx = {
  producerRunId: '11111111-1111-4111-a111-111111111111',
  environment: 'production' as const,
};

function perfPayload(action = 'triggered') {
  return {
    action,
    data: {
      event: {
        id: 'abcdef0123456789',
        title: 'page_stall',
        level: 'warning',
        transaction: '/chats',
        timestamp: '2026-10-22T06:00:00+00:00',
        tags: [
          { key: 'perf_event', value: 'page_stall' },
          { key: 'route', value: '/chats' },
        ],
      },
    },
  };
}

describe('convertSentryAlert', () => {
  it('maps a perf event to a schema-valid experience evaluation', () => {
    const out = convertSentryAlert(perfPayload(), ctx);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;

    expect(AlertEvaluationSchema.safeParse(out.evaluation).success).toBe(true);
    expect(out.evaluation.domain).toBe('experience');
    expect(out.evaluation.state).toBe('firing');
    expect(out.evaluation.severity).toBe('P1');
    expect(out.evaluation.fingerprint).toContain('experience');
    expect(out.evaluation.fingerprint).toContain('page_stall');
    expect(out.evaluation.title).toContain('/chats');
  });

  it('keys the fingerprint on perf event and route so repeated stalls merge into one incident', () => {
    const a = convertSentryAlert(perfPayload(), ctx);
    const b = convertSentryAlert(perfPayload(), {
      ...ctx,
      producerRunId: '22222222-2222-4222-a222-222222222222',
    });
    expect(a.kind === 'ok' && b.kind === 'ok' && a.evaluation.fingerprint).toBe(
      b.kind === 'ok' ? b.evaluation.fingerprint : ''
    );
  });

  it('turns resolved into a healthy evaluation', () => {
    const out = convertSentryAlert(perfPayload('resolved'), ctx);
    expect(out.kind === 'ok' && out.evaluation.state).toBe('healthy');
  });

  it('accepts the newer issue payload shape', () => {
    const out = convertSentryAlert(
      {
        action: 'created',
        data: {
          issue: {
            id: '1',
            shortId: 'ST-MINIAPP-1',
            title: 'TypeError: x is undefined',
            level: 'error',
          },
        },
      },
      ctx
    );
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.evaluation.domain).toBe('errors');
    expect(AlertEvaluationSchema.safeParse(out.evaluation).success).toBe(true);
  });

  it('escalates fatal errors to P0 and keeps asset failures at P2', () => {
    const fatal = convertSentryAlert(
      { action: 'created', data: { issue: { id: '2', title: 'boom', level: 'fatal' } } },
      ctx
    );
    expect(fatal.kind === 'ok' && fatal.evaluation.severity).toBe('P0');

    const asset = convertSentryAlert(
      {
        action: 'triggered',
        data: {
          event: {
            id: '3',
            title: 'asset_load_failed',
            tags: [{ key: 'perf_event', value: 'asset_load_failed' }],
          },
        },
      },
      ctx
    );
    expect(asset.kind === 'ok' && asset.evaluation.severity).toBe('P2');
  });

  it('ignores payloads that are not alerts', () => {
    expect(convertSentryAlert({}, ctx)).toEqual({ kind: 'ignored', reason: 'not_an_alert' });
    expect(convertSentryAlert({ action: 'assigned' }, ctx)).toEqual({
      kind: 'ignored',
      reason: 'unsupported_action',
    });
  });

  it('maps a metric alert to an experience evaluation keyed on the rule name', () => {
    const out = convertSentryAlert(
      {
        action: 'critical',
        data: {
          metric_alert: {
            id: 42,
            title: 'P1 页面卡住人数',
            alert_rule: {
              id: 9001,
              name: 'P1 页面卡住人数',
              aggregate: 'count_unique(user)',
            },
            date_started: '2026-10-22T06:00:00+00:00',
          },
        },
      },
      ctx
    );
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;

    expect(AlertEvaluationSchema.safeParse(out.evaluation).success).toBe(true);
    expect(out.evaluation.domain).toBe('experience');
    expect(out.evaluation.severity).toBe('P1');
    expect(out.evaluation.state).toBe('firing');
    expect(out.evaluation.fingerprint).toContain('sentry:metric:');
  });

  it('keeps a non-stall metric alert in the errors domain and honours the P0 prefix', () => {
    const out = convertSentryAlert(
      {
        action: 'critical',
        data: {
          metric_alert: {
            title: 'P0 核心接口 5xx 比例',
            alert_rule: { id: 1, name: 'P0 核心接口 5xx 比例' },
          },
        },
      },
      ctx
    );
    expect(out.kind === 'ok' && out.evaluation.domain).toBe('errors');
    expect(out.kind === 'ok' && out.evaluation.severity).toBe('P0');
  });

  it('folds repeated triggers of the same metric rule into one fingerprint', () => {
    const payload = (action: string) => ({
      action,
      data: {
        metric_alert: {
          title: 'P1 页面卡住人数',
          alert_rule: { id: 9001, name: 'P1 页面卡住人数' },
        },
      },
    });
    const first = convertSentryAlert(payload('warning'), ctx);
    const second = convertSentryAlert(payload('critical'), {
      ...ctx,
      producerRunId: '33333333-3333-4333-a333-333333333333',
    });
    expect(first.kind === 'ok' && first.evaluation.fingerprint).toBe(
      second.kind === 'ok' ? second.evaluation.fingerprint : ''
    );
  });

  it('never carries URLs or user identifiers into the alert', () => {
    const out = convertSentryAlert(
      {
        action: 'triggered',
        data: {
          event: {
            id: 'abc',
            title: 'page_stall',
            web_url: 'https://sentry.io/x/?token=secret',
            tags: [
              { key: 'perf_event', value: 'page_stall' },
              { key: 'route', value: '/chats' },
              { key: 'telegram_user_id', value: '7432371465' },
            ],
          },
        },
      },
      ctx
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('7432371465');
    expect(serialized).not.toContain('https://sentry.io');
  });
});
