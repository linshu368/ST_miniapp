import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { fastifyLoggerOptions } from '../../lib/logger-options.js';
import { parseLogAlertPolicy } from './alert-policy.js';
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
          err: new Error('private-body'),
          body: 'private-body',
          token: 'private-token',
        },
        'private-message'
      );
      expect(received).toHaveLength(1);
      expect(JSON.stringify(received)).not.toContain('private');
      expect(JSON.parse(lines[0] ?? '{}').event_id).toBe(received[0]?.event_id);
      logger.error({ event: 'observability.alert.delivery_failed' });
      expect(received).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
