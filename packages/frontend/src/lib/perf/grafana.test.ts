import type { BrowserConfig, TransportItem } from '@grafana/faro-web-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEngineeringExporter } from './grafana';

function fakeSdk() {
  const measurement = vi.fn();
  const event = vi.fn();
  const initialize = vi.fn((_config: BrowserConfig) => ({
    api: { pushMeasurement: measurement, pushEvent: event },
  }));
  const transport = vi.fn();
  const sdk = {
    initializeFaro: initialize,
    FetchTransport: transport,
    InternalLoggerLevel: { OFF: 0 },
  } as unknown as typeof import('@grafana/faro-web-sdk');
  return { sdk, initialize, transport, measurement, event };
}

describe('bounded engineering Faro exporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_GRAFANA_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_GRAFANA_ENVIRONMENT', 'test');
    vi.stubEnv('NEXT_PUBLIC_GRAFANA_RELEASE', 'test-release-1');
    vi.stubEnv(
      'NEXT_PUBLIC_GRAFANA_COLLECTOR_URL',
      'https://collector.example.test/collect/public-app-key'
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not import or send when disabled or when public config is invalid', async () => {
    const loader = vi.fn();
    for (const url of [
      '',
      'http://collector.example.test',
      'https://secret@collector.example.test',
      'https://collector.example.test/?token=secret',
    ]) {
      vi.stubEnv('NEXT_PUBLIC_GRAFANA_COLLECTOR_URL', url);
      const exporter = createEngineeringExporter(loader);
      exporter.measurement('page.ready', 10);
      await exporter.initialize();
      expect(exporter.health().source_disabled).toBe(1);
    }
    vi.stubEnv('NEXT_PUBLIC_GRAFANA_ENABLED', 'false');
    await createEngineeringExporter(loader).initialize();
    expect(loader).not.toHaveBeenCalled();
  });

  it('exports only bounded public catalog model and numeric policy fields for first-token analysis', async () => {
    const fake = fakeSdk();
    const exporter = createEngineeringExporter(async () => fake.sdk);
    await exporter.initialize();
    exporter.measurement('roleplay.first_token', 2100, {
      requested_model: 'deepseek-v4-flash',
      deadline_ms: 6000,
      outcome: 'observed',
      request_id: 'PRIVATE_REQUEST',
      user_id: 'PRIVATE_USER',
    });
    expect(fake.measurement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        context: expect.objectContaining({
          requested_model: 'deepseek-v4-flash',
          deadline_ms: '6000',
        }),
      })
    );
    exporter.event('roleplay.terminal', {
      requested_model: '11111111-1111-4111-8111-111111111111',
      deadline_ms: true,
      outcome: 'timed_out',
    });
    const attrs = fake.event.mock.calls.at(-1)![1];
    expect(attrs.requested_model).toBe('unknown');
    expect(attrs.deadline_ms).toBeUndefined();
    expect(JSON.stringify(fake.measurement.mock.calls)).not.toMatch(/PRIVATE_|request_id|user_id/);
  });

  it('initializes once, transports only approved custom signals and strips unsafe fields twice', async () => {
    const fake = fakeSdk();
    const loader = vi.fn(async () => fake.sdk);
    const exporter = createEngineeringExporter(loader);
    exporter.measurement('page.ready', 123, {
      route: '/chat/:id',
      user_id: 'secret-user',
      character_id: 'secret-character',
      request_id: 'secret-request',
      query: 'secret-query',
      outcome: 'ready',
      source_measurement_version: 'page_mount_v1',
      net_type: 'anything',
      measurement_version: 'unsafe',
    });
    exporter.event('page.terminal', { route: '/raw-user-path', outcome: 'ready' });
    await Promise.all([exporter.initialize(), exporter.initialize()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fake.initialize).toHaveBeenCalledTimes(1);
    expect(fake.measurement).toHaveBeenCalledWith(
      { type: 'st_page_ready', values: { duration_ms: 123 } },
      expect.objectContaining({
        skipDedupe: true,
        context: {
          route: '/chat/:id',
          outcome: 'ready',
          source_measurement_version: 'page_mount_v1',
          net_type: 'other',
          schema_version: '1',
          measurement_version: 'engineering_v1',
        },
      })
    );
    const config = fake.initialize.mock.calls[0]![0];
    expect(config).toMatchObject({
      instrumentations: [],
      metas: [],
      sessionTracking: { enabled: false },
      isolate: true,
      preventGlobalExposure: true,
    });
    expect(fake.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        bufferSize: 20,
        concurrency: 1,
        requestTimeoutMs: 3000,
        retry: { maxAttempts: 1 },
      })
    );
    const item = {
      type: 'measurement',
      meta: {
        page: { url: 'https://private/?secret=1' },
        user: { id: 'private' },
        session: { id: 'private' },
      },
      payload: {
        type: 'st_page_ready',
        timestamp: '2026-10-29T00:00:00Z',
        values: { duration_ms: 123, secret: 99 },
        context: { route: '/chat/:id', request_id: 'private' },
        trace: { trace_id: 'private' },
      },
    } as TransportItem;
    const sanitized = config.beforeSend!(item);
    expect(sanitized).toEqual({
      type: 'measurement',
      meta: { app: { name: 'st-miniapp', environment: 'test', version: 'test-release-1' } },
      payload: {
        type: 'st_page_ready',
        timestamp: '2026-10-29T00:00:00Z',
        values: { duration_ms: 123 },
        context: { route: '/chat/:id', schema_version: '1', measurement_version: 'engineering_v1' },
      },
    });
    expect(
      config.beforeSend!({
        ...item,
        type: 'event' as TransportItem['type'],
        payload: { name: 'session_start', timestamp: '' },
      })
    ).toBeNull();
    expect(JSON.stringify([fake.measurement.mock.calls, sanitized])).not.toMatch(
      /secret|private|request_id|user_id|character_id/
    );
    expect(fake.event).toHaveBeenCalledWith(
      'st_page_terminal',
      expect.objectContaining({ route: 'other' }),
      'st.engineering',
      expect.anything()
    );
  });

  it('bounds the pre-load queue, gives up after three seconds and ignores a late SDK', async () => {
    const fake = fakeSdk();
    let resolveSdk!: (sdk: typeof fake.sdk) => void;
    const exporter = createEngineeringExporter(
      () =>
        new Promise((resolve) => {
          resolveSdk = resolve;
        })
    );
    for (let i = 0; i < 1000; i++) exporter.measurement('page.ready', i);
    expect(exporter.health()).toMatchObject({
      source_accepted: 64,
      source_dropped: 936,
      source_queued: 64,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(exporter.health()).toMatchObject({ source_dropped: 1000, source_queued: 0 });
    resolveSdk(fake.sdk);
    await exporter.initialize();
    expect(fake.initialize).not.toHaveBeenCalled();
    expect(() => exporter.event('page.started')).not.toThrow();
  });

  it('isolates loader and SDK exceptions and rejects arbitrary metric names/nonfinite durations', async () => {
    const broken = createEngineeringExporter(async () => {
      throw new Error('offline');
    });
    broken.event('page.started');
    await broken.initialize();
    expect(broken.health().source_dropped).toBe(1);
    const fake = fakeSdk();
    fake.measurement.mockImplementation(() => {
      throw new Error('transport failed');
    });
    const exporter = createEngineeringExporter(async () => fake.sdk);
    exporter.measurement('raw.arbitrary.name', 1);
    exporter.measurement('page.ready', NaN);
    exporter.measurement('page.ready', -1);
    exporter.measurement('page.ready', Infinity);
    exporter.measurement('page.ready', 86_400_001);
    exporter.measurement('page.ready', 1);
    await exporter.initialize();
    expect(exporter.health()).toMatchObject({
      source_invalid: 5,
      source_dropped: 1,
      source_queued: 0,
    });
  });

  it.each([401, 429])(
    'uses the real SDK bounded transport without retries on HTTP %s',
    async (status) => {
      vi.stubGlobal(
        'window',
        Object.assign(new EventTarget(), { location: { href: 'https://app.test/?private=1' } })
      );
      const fetchMock = vi.fn(
        async () => new Response('', { status, headers: { 'Retry-After': '3600' } })
      );
      vi.stubGlobal('fetch', fetchMock);
      const exporter = createEngineeringExporter();
      exporter.measurement('page.ready', 123, { route: '/', outcome: 'ready' });
      await exporter.initialize();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exporter.health().source_transport_failures).toBe(1);
      const [, options] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
      expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(JSON.parse(String(options.body))).toMatchObject({
        meta: { app: { name: 'st-miniapp', environment: 'test', version: 'test-release-1' } },
      });
      expect(String(options.body)).not.toMatch(/private|session|userAgent|page_url/);
    }
  );

  it('aborts the real SDK intake request after three seconds without unhandled rejection', async () => {
    vi.stubGlobal('window', new EventTarget());
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = options?.signal ?? undefined;
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const exporter = createEngineeringExporter();
    exporter.event('page.started', { route: '/' });
    await exporter.initialize();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exporter.health().source_transport_failures).toBe(1);
  });
});
