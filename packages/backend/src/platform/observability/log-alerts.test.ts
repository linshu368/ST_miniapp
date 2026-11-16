import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { fastifyLoggerOptions } from './logger-options.js';
import { matchesLogRule, parseLogAlertPolicy } from './alert-policy.js';
import { createLogAlerts } from './log-alerts.js';
import { subscribeLogAlerts, type AlertLog } from './log-channel.js';

const event: AlertLog = {
  event_id: '00000000-0000-4000-8000-000000000001',
  event: 'operation.terminal',
  operation: 'payment.settlement',
  level: 50,
  outcome: 'failed',
  http_status: 500,
};
afterEach(() => vi.useRealTimers());

describe('direct runtime log alerts', () => {
  it('matches unlabelled warnings only when configured, preserves correlation and skips work after stop', () => {
    const received: AlertLog[] = [];
    const lines: string[] = [];
    const stop = subscribeLogAlerts((entry) => received.push(entry));
    const logger = pino(
      { ...fastifyLoggerOptions(), level: 'info', transport: undefined },
      {
        write(line: string) {
          lines.push(line);
        },
      }
    );
    try {
      logger.warn(
        { reason: 'fixture_warning', err: new Error('private fixture') },
        'private fixture'
      );
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ event: 'logger.warn', level: 40 });
      const rules = parseLogAlertPolicy(
        'true',
        '[{"id":"warnings","min_level":"warn","events":["logger.warn"]}]'
      ).rules;
      expect(matchesLogRule(rules[0]!, received[0]!)).toBe(true);
      expect(matchesLogRule(parseLogAlertPolicy('true').rules[0]!, received[0]!)).toBe(false);
      expect(JSON.parse(lines[0]!).event_id).toBe(received[0]!.event_id);
      expect(lines.join('')).not.toContain('private fixture');
    } finally {
      stop();
    }
    logger.warn({ reason: 'fixture_disabled' });
    expect(received).toHaveLength(1);
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('event_id');
  });
  it('alerts on legacy errors and public codes while retaining distinct codes and safe aliases', () => {
    const received: AlertLog[] = [];
    const lines: string[] = [];
    const stop = subscribeLogAlerts((entry) => received.push(entry));
    const logger = pino(
      { ...fastifyLoggerOptions(), level: 'info', transport: undefined },
      new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      })
    );
    try {
      logger.error(new Error('private-error'));
      logger.error({ err: new Error('private-error') });
      logger.fatal('private-text');
      logger.error({
        event: 'operation.terminal',
        operation: 'http.request',
        error_code: 'DEPENDENCY_FAILED',
        public_error_code: 'AUTH_DEPENDENCY_UNAVAILABLE',
        statusCode: 503,
        durationMs: 9000,
      });
      expect(received.map((entry) => entry.event)).toEqual([
        'logger.error',
        'logger.error',
        'logger.fatal',
        'operation.terminal',
      ]);
      expect(received[3]).toMatchObject({
        error_code: 'DEPENDENCY_FAILED',
        public_error_code: 'AUTH_DEPENDENCY_UNAVAILABLE',
        http_status: 503,
        duration_ms: 9000,
      });
      for (const errorCode of ['DEPENDENCY_FAILED', 'AUTH_DEPENDENCY_UNAVAILABLE']) {
        const rule = parseLogAlertPolicy(
          'true',
          JSON.stringify([
            { id: 'code', error_codes: [errorCode], min_http_status: 500, min_duration_ms: 8000 },
          ])
        ).rules[0]!;
        expect(matchesLogRule(rule, received[3]!)).toBe(true);
      }
      const strict = parseLogAlertPolicy(
        'true',
        JSON.stringify([{ id: 'public', public_error_codes: ['AUTH_DEPENDENCY_UNAVAILABLE'] }])
      ).rules[0]!;
      expect(matchesLogRule(strict, received[3]!)).toBe(true);
      expect(matchesLogRule(strict, { ...event, error_code: 'AUTH_DEPENDENCY_UNAVAILABLE' })).toBe(
        false
      );
      expect(lines.join('')).not.toContain('private');
      received.forEach((entry, index) =>
        expect(JSON.parse(lines[index]!).event_id).toBe(entry.event_id)
      );
      logger.error({ event: 'invalid.numbers', statusCode: 999, durationMs: Infinity });
      expect(received.at(-1)).not.toHaveProperty('http_status');
      expect(received.at(-1)).not.toHaveProperty('duration_ms');
    } finally {
      stop();
    }
    const before = received.length;
    logger.error({ err: new Error('private-disabled') });
    expect(received).toHaveLength(before);
  });

  it('does no parsing or sending while disabled, even with invalid rule config', async () => {
    const sink = { deliver: vi.fn() };
    const alerts = createLogAlerts(parseLogAlertPolicy(undefined, 'not-json'), sink, vi.fn());
    alerts.accept(event);
    await alerts.close();
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(() => parseLogAlertPolicy('TRUE')).toThrow('must be true or false');
    expect(() => parseLogAlertPolicy('true', '[{"id":"x","extra":"private"}]')).toThrow(
      'valid rules'
    );
  });

  it('matches all configured predicates and sends only the first matching safe card', async () => {
    const sink = { deliver: vi.fn().mockResolvedValue({ kind: 'succeeded' }) };
    const policy = parseLogAlertPolicy(
      'true',
      JSON.stringify([
        {
          id: 'payment',
          operations: ['payment.settlement'],
          outcomes: ['failed'],
          min_http_status: 500,
        },
        { id: 'fallback' },
      ])
    );
    const alerts = createLogAlerts(policy, sink, vi.fn());
    alerts.accept({ ...event, level: 30 });
    expect(sink.deliver).not.toHaveBeenCalled();
    alerts.accept(event);
    await alerts.close();
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(sink.deliver.mock.calls[0]?.[0]).toMatchObject({
      title: 'Backend payment',
      notification_key: event.event_id,
    });
  });

  it('bounds concurrency and shutdown and never retries or recursively alerts on internal failure', async () => {
    vi.useFakeTimers();
    const sink = { deliver: vi.fn(() => new Promise<never>(() => {})) };
    const health = vi.fn();
    const alerts = createLogAlerts(parseLogAlertPolicy('true'), sink, health);
    for (let i = 0; i < 6; i++) alerts.accept(event);
    alerts.accept({ ...event, event: 'observability.alert.delivery_failed' });
    expect(sink.deliver).toHaveBeenCalledTimes(4);
    expect(alerts.health()).toMatchObject({ in_flight: 4, dropped: 2 });
    const close = alerts.close();
    await vi.advanceTimersByTimeAsync(2500);
    await close;
    expect(alerts.health()).toMatchObject({ in_flight: 0, failures: 4 });
    alerts.accept(event);
    expect(sink.deliver).toHaveBeenCalledTimes(4);
  });

  it('contains sync/async delivery and health reporter failures', async () => {
    const sink = { deliver: vi.fn().mockRejectedValue(new Error('private response')) };
    const health = vi.fn(() => {
      throw new Error('observer failure');
    });
    const alerts = createLogAlerts(parseLogAlertPolicy('true'), sink, health);
    alerts.accept(event);
    await alerts.close();
    expect(health).toHaveBeenCalledWith('delivery_failed', 1);
  });

  it('projects legacy Pino logs without forwarding body, user, credentials or error text', () => {
    const received: AlertLog[] = [];
    const lines: string[] = [];
    const stop = subscribeLogAlerts((entry) => received.push(entry));
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    try {
      logger.child({ module: 'payment' }).error(
        {
          event: 'payment.failed',
          user_id: '11111111-1111-4111-8111-111111111111',
          telegram_user_id: '123456',
          session_id: '22222222-2222-4222-8222-222222222222',
          err: new Error('private-body'),
          body: 'private-body',
          token: 'private-token',
        },
        'private-message'
      );
      expect(received).toHaveLength(1);
      expect(JSON.stringify(received)).not.toContain('private');
      expect(received[0]).not.toHaveProperty('user_id');
      expect(received[0]).not.toHaveProperty('telegram_user_id');
      expect(received[0]).not.toHaveProperty('session_id');
      expect(JSON.parse(lines[0] ?? '{}').user_id).toBe('11111111-1111-4111-8111-111111111111');
      expect(JSON.parse(lines[0] ?? '{}').event_id).toBe(received[0]?.event_id);
      logger.error({ event: 'observability.alert.delivery_failed' });
      expect(received).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
