import { afterEach, describe, expect, it, vi } from 'vitest';

const sentryTracing = vi.hoisted(() => ({
  getClient: vi.fn(),
  addIntegration: vi.fn(),
  browserTracingIntegration: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => sentryTracing);

import { installDeferredTracing } from './tracing';

import { sanitizeStartupDiagnostic, sanitizeStartupMetric, sanitizeTelemetry } from './sanitize';

describe('startup metric attributes', () => {
  it('removes SDK identity, replay and unexpected attributes while retaining P95 dimensions', () => {
    const metric = {
      name: 'startup.shell_ready.duration',
      value: 1200,
      type: 'distribution',
      attributes: {
        route: '/dramas',
        tg_platform: 'android',
        net_type: '4g',
        measurement: 'post_render_frame',
        telegram_ready: 'sent',
        'sentry.release': 'test-release',
        'sentry.environment': 'production',
        'user.id': 'private-user',
        'user.email': 'private-email',
        'sentry.replay_id': 'private-replay',
        initData: 'sensitive',
      },
    };
    const result = sanitizeStartupMetric(metric);
    expect(result.attributes).toEqual({
      route: '/dramas',
      tg_platform: 'android',
      net_type: '4g',
      measurement: 'post_render_frame',
      telegram_ready: 'sent',
      'sentry.release': 'test-release',
      'sentry.environment': 'production',
    });
    expect(result.value).toBe(1200);
    expect(metric.attributes['user.id']).toBe('private-user');
    expect(sanitizeStartupMetric({ name: 'startup.outcome', value: 1 })).toEqual({
      name: 'startup.outcome',
      value: 1,
      attributes: {},
    });
  });

  it('preserves the existing handling of other metrics', () => {
    const metric = { name: 'page.ready.duration', value: 100, attributes: { route: '/' } };
    expect(sanitizeStartupMetric(metric)).toBe(metric);
  });

  it('only permits finite stage names and removes arbitrary resource or user dimensions', () => {
    const attributes = {
      stage: 'telegram_init',
      startup_bucket: 'slow',
      definition: 'startup_phases_v1',
      url: 'private-url',
      'user.id': 'private-id',
    };
    expect(
      sanitizeStartupMetric({ name: 'startup.stage.duration', attributes }).attributes
    ).toEqual({ stage: 'telegram_init', startup_bucket: 'slow', definition: 'startup_phases_v1' });
    expect(
      sanitizeStartupMetric({
        name: 'startup.stage.duration',
        attributes: { stage: 'private-user' },
      }).attributes
    ).toEqual({});
  });

  it('strips SDK identity and contexts from slow diagnostics while preserving numeric evidence', () => {
    const event = {
      type: undefined,
      event_id: 'event',
      message: 'miniapp_startup_slow',
      release: 'release',
      environment: 'production',
      user: { id: 'private-user', ip_address: 'private-ip' },
      request: { url: 'private-url' },
      breadcrumbs: [{ message: 'private-message' }],
      extra: { body: 'private-body' },
      contexts: {
        trace: { trace_id: 'private-trace', span_id: 'private-span' },
        replay: { replay_id: 'private-replay' },
        startup: {
          before_providers: 5500,
          ready_call: 1,
          script_count: 8,
          arbitrary: 'private-value',
          bootstrap: NaN,
          paint_wait: -1,
        },
      },
      tags: { route: '/', tg_platform: 'android', startup_bucket: 'slow', user_id: 'private-id' },
    };
    const result = sanitizeStartupDiagnostic(event);
    expect(result.contexts).toEqual({
      startup: { before_providers: 5500, ready_call: 1, script_count: 8 },
    });
    expect(result.tags).toEqual({ route: '/', tg_platform: 'android', startup_bucket: 'slow' });
    expect(result.release).toBe('release');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(event.user.id).toBe('private-user');
    const ordinary = { type: undefined, message: 'ordinary', user: { id: 'existing-user' } };
    expect(sanitizeStartupDiagnostic(ordinary)).toBe(ordinary);
  });
});

describe('sanitizeTelemetry', () => {
  it('redacts sensitive keys case-insensitively at every depth', () => {
    const input = {
      Authorization: 'Bearer secret',
      nested: {
        'X-Init-Data': 'signed telegram data',
        access_token: 'access secret',
        characterId: 'character-1',
      },
    };

    expect(sanitizeTelemetry(input)).toEqual({
      Authorization: '[Filtered]',
      nested: {
        'X-Init-Data': '[Filtered]',
        access_token: '[Filtered]',
        characterId: 'character-1',
      },
    });
  });

  it('redacts authentication query parameters while preserving ordinary text', () => {
    const input = {
      url: 'https://example.test/path?foo=hello&tgWebAppData=signed-data&token=abc#section',
      conversation: '用户说：请保留这段正常对话。',
    };

    expect(sanitizeTelemetry(input)).toEqual({
      url: 'https://example.test/path?foo=hello&tgWebAppData=[Filtered]&token=[Filtered]#section',
      conversation: '用户说：请保留这段正常对话。',
    });
  });

  it('redacts Telegram init data at the start of a URL fragment', () => {
    const input = {
      url: 'https://example.test/#tgWebAppData=user%3D1%26auth_date%3D2%26hash%3Dsigned&tgWebAppVersion=8.0',
    };

    expect(sanitizeTelemetry(input)).toEqual({
      url: 'https://example.test/#tgWebAppData=[Filtered]&tgWebAppVersion=8.0',
    });
  });

  it('sanitizes arrays without mutating the original value', () => {
    const input = {
      headers: [{ Cookie: 'session=secret' }, { accept: 'application/json' }],
    };
    const output = sanitizeTelemetry(input);

    expect(output).toEqual({
      headers: [{ Cookie: '[Filtered]' }, { accept: 'application/json' }],
    });
    expect(input).toEqual({
      headers: [{ Cookie: 'session=secret' }, { accept: 'application/json' }],
    });
    expect(output).not.toBe(input);
    expect(output.headers).not.toBe(input.headers);
  });

  describe('bounded traversal', () => {
    function nest(depth: number): Record<string, unknown> {
      const root: Record<string, unknown> = {};
      let cursor = root;
      for (let i = 0; i < depth; i += 1) {
        const child: Record<string, unknown> = {};
        cursor.child = child;
        cursor = child;
      }
      return root;
    }

    it('does not overflow the stack on pathologically deep input', () => {
      expect(() => sanitizeTelemetry(nest(100_000))).not.toThrow();
    });

    it('truncates beyond the depth limit by default', () => {
      const output = sanitizeTelemetry({ a: { b: { c: 'x' } } }, { maxDepth: 2 }) as {
        a: { b: unknown };
      };
      expect(output.a.b).toBe('[Truncated]');
    });

    it('keeps deeper nodes untouched in passthrough mode while still redacting the shallow part', () => {
      const deep = { tree: { token: 'kept-as-is' } };
      const output = sanitizeTelemetry(
        { url: 'https://x.test/?token=abc', data: { node: deep } },
        { maxDepth: 2, beyondLimit: 'passthrough' }
      ) as { url: string; data: { node: unknown } };

      expect(output.url).toBe('https://x.test/?token=[Filtered]');
      expect(output.data.node).toBe(deep);
    });

    it('stops expanding once the node budget is spent', () => {
      const wide = Array.from({ length: 50 }, (_, i) => ({ i }));
      const output: unknown[] = sanitizeTelemetry(wide, { maxNodes: 10 });
      expect(output.filter((item) => item === '[Truncated]').length).toBeGreaterThan(0);
    });
  });
});

describe('deferred tracing', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('does nothing when the startup error/metrics client is disabled', () => {
    sentryTracing.getClient.mockReturnValue(undefined);
    installDeferredTracing();
    expect(sentryTracing.addIntegration).not.toHaveBeenCalled();
  });

  it('adds tracing to the existing client once and preserves request filters', () => {
    const getIntegrationByName = vi.fn();
    const integration = { name: 'BrowserTracing' };
    sentryTracing.getClient.mockReturnValue({ getIntegrationByName });
    sentryTracing.browserTracingIntegration.mockReturnValue(integration);
    sentryTracing.addIntegration.mockImplementation(() =>
      getIntegrationByName.mockReturnValue(integration)
    );
    installDeferredTracing();
    installDeferredTracing();
    expect(sentryTracing.addIntegration).toHaveBeenCalledExactlyOnceWith(integration);
    const filter =
      sentryTracing.browserTracingIntegration.mock.calls[0]![0].shouldCreateSpanForRequest;
    expect(filter('https://app.posthog.com/flags')).toBe(false);
    expect(filter('https://api.example.test/api/dramas')).toBe(true);
  });
});
