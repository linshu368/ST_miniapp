import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReplayTelemetryEvent } from '@miniapp/shared';
import {
  captureReplayTelemetryEvent,
  isPosthogCaptureConfigured,
  resetPosthogCaptureDedupeForTests,
  resolvePosthogCaptureUrl,
  type PosthogCaptureConfig,
  type PosthogCaptureLogger,
} from './posthog-capture.js';

const settledEvent = {
  event: 'payment_order_settled',
  telegram_user_id: '123456789',
  occurred_at: '2026-09-15T10:00:00.000Z',
  order_id: 'MA-order-1',
  payment_type: 'wxpay',
  order_status: 'completed',
  settled_by: 'webhook',
} satisfies ReplayTelemetryEvent;

function createLog(): PosthogCaptureLogger {
  return {
    biz: { info: vi.fn() },
    sys: { warn: vi.fn(), error: vi.fn() },
  };
}

function enabledConfig(overrides: Partial<PosthogCaptureConfig> = {}): PosthogCaptureConfig {
  return {
    apiKey: 'phc_test_key',
    host: 'https://us.i.posthog.com',
    timeoutMs: 50,
    ...overrides,
  };
}

beforeEach(() => {
  resetPosthogCaptureDedupeForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolvePosthogCaptureUrl', () => {
  it('accepts HTTPS US Cloud host and appends the capture path', () => {
    expect(resolvePosthogCaptureUrl('https://us.i.posthog.com')).toBe(
      'https://us.i.posthog.com/i/v0/e/'
    );
  });

  it('rejects http, credentials in the URL, and invalid hosts', () => {
    expect(resolvePosthogCaptureUrl('http://us.i.posthog.com')).toBeNull();
    expect(resolvePosthogCaptureUrl('https://user:pass@us.i.posthog.com')).toBeNull();
    expect(resolvePosthogCaptureUrl('not-a-url')).toBeNull();
  });
});

describe('isPosthogCaptureConfigured', () => {
  it('is false when the project key is missing', () => {
    expect(isPosthogCaptureConfigured(() => enabledConfig({ apiKey: '' }))).toBe(false);
  });

  it('is true for a HTTPS host and non-empty key', () => {
    expect(isPosthogCaptureConfigured(() => enabledConfig())).toBe(true);
  });
});

describe('captureReplayTelemetryEvent', () => {
  it('skips without calling fetch when unconfigured', async () => {
    const fetchImpl = vi.fn();
    const result = await captureReplayTelemetryEvent(settledEvent, createLog(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getConfig: () => enabledConfig({ apiKey: '' }),
    });
    expect(result).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a schema-safe payload with the Telegram identity and no forbidden fields', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe('https://us.i.posthog.com/i/v0/e/');
      const body = JSON.parse(String(init?.body)) as {
        api_key: string;
        event: string;
        distinct_id: string;
        properties: Record<string, unknown>;
      };
      expect(body.api_key).toBe('phc_test_key');
      expect(body.event).toBe('payment_order_settled');
      expect(body.distinct_id).toBe('123456789');
      expect(body.properties).toMatchObject({
        telegram_user_id: '123456789',
        order_id: 'MA-order-1',
        order_status: 'completed',
        settled_by: 'webhook',
      });
      expect(body.properties).not.toHaveProperty('pay_url');
      expect(body.properties).not.toHaveProperty('initData');
      expect(body.properties).not.toHaveProperty('user_cohort');
      expect(body.properties).not.toHaveProperty('event');
      return new Response(null, { status: 200 });
    });

    const result = await captureReplayTelemetryEvent(settledEvent, createLog(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getConfig: () => enabledConfig(),
    });

    expect(result).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('dedupes the same order_id + status + settled_by after a successful send', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const deps = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getConfig: () => enabledConfig(),
    };

    expect(await captureReplayTelemetryEvent(settledEvent, createLog(), deps)).toBe('sent');
    expect(await captureReplayTelemetryEvent(settledEvent, createLog(), deps)).toBe('skipped');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not throw when capture times out', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn(async () => {
      throw timeout;
    });
    const log = createLog();

    await expect(
      captureReplayTelemetryEvent(settledEvent, log, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getConfig: () => enabledConfig(),
      })
    ).resolves.toBe('failed');

    expect(log.sys.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'posthog.capture.failed',
        err: timeout,
      }),
      'PostHog capture 失败'
    );
  });
});
