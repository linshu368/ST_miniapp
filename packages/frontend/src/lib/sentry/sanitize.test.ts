import { describe, expect, it } from 'vitest';

import { sanitizeStartupMetric, sanitizeTelemetry } from './sanitize';

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
