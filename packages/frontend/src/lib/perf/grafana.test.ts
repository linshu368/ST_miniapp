import type { BrowserConfig, Faro, FetchTransport, TransportItem } from '@grafana/faro-web-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEngineeringExporter } from './grafana';

function fakeSdk() {
  const measurement = vi.fn();
  const event = vi.fn();
  const initialize = vi.fn((_config: BrowserConfig) => ({
    api: { pushMeasurement: measurement, pushEvent: event },
  }));
  const transport = vi.fn();
  const genShortID = vi.fn(() => 'a'.repeat(32));
  const sdk = {
    initializeFaro: initialize,
    FetchTransport: transport,
    InternalLoggerLevel: { OFF: 0 },
    genShortID,
    VERSION: 'test-sdk-version',
  } as unknown as typeof import('@grafana/faro-web-sdk');
  return { sdk, initialize, transport, measurement, event, genShortID };
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
    const fake = fakeSdk();
    const loader = vi.fn(async () => fake.sdk);
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
    expect(fake.genShortID).not.toHaveBeenCalled();
    expect(fake.transport).not.toHaveBeenCalled();
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
    expect(fake.genShortID).toHaveBeenCalledExactlyOnceWith(32);
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
        requestOptions: {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { 'X-Faro-Session-Id': 'a'.repeat(32) },
        },
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
      meta: {
        app: { name: 'st-miniapp', environment: 'test', version: 'test-release-1' },
        sdk: { name: '@grafana/faro-web-sdk', version: 'test-sdk-version' },
      },
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
    expect(fake.genShortID).not.toHaveBeenCalled();
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
      const { VERSION } = await import('@grafana/faro-web-sdk');
      exporter.measurement('page.ready', 123, { route: '/', outcome: 'ready' });
      await exporter.initialize();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exporter.health().source_transport_failures).toBe(1);
      const [, options] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
      expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
      const transportSessionId = new Headers(options.headers).get('X-Faro-Session-Id');
      expect(transportSessionId).toMatch(/^[a-zA-Z0-9]{32}$/);
      expect([...new Headers(options.headers).keys()].sort()).toEqual([
        'content-type',
        'x-faro-session-id',
      ]);
      expect(JSON.parse(String(options.body))).toMatchObject({
        meta: {
          app: { name: 'st-miniapp', environment: 'test', version: 'test-release-1' },
          sdk: { name: '@grafana/faro-web-sdk', version: VERSION },
        },
      });
      expect(String(options.body)).not.toMatch(/private|session|userAgent|page_url/);
      expect(String(options.body)).not.toContain(transportSessionId!);
    }
  );

  it('keeps the intake identifier in headers for one exporter only without persisting it', async () => {
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const sessionStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        location: { href: 'https://app.test/?private=1' },
        localStorage,
        sessionStorage,
      })
    );
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = createEngineeringExporter();
    first.event('page.started', { route: '/' });
    await first.initialize();
    await vi.advanceTimersByTimeAsync(1_100);
    first.event('page.terminal', { route: '/', outcome: 'error' });
    await vi.advanceTimersByTimeAsync(1_100);
    const second = createEngineeringExporter();
    second.event('page.started', { route: '/' });
    await second.initialize();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
      ([, request]) => request
    );
    const ids = requests.map((request) => new Headers(request.headers).get('X-Faro-Session-Id'));
    expect(ids[0]).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(ids[2]).not.toBe(ids[0]);
    const { VERSION } = await import('@grafana/faro-web-sdk');
    for (const request of requests) {
      expect([...new Headers(request.headers).keys()].sort()).toEqual([
        'content-type',
        'x-faro-session-id',
      ]);
      const body = String(request.body);
      expect(JSON.parse(body).meta).toEqual({
        app: { name: 'st-miniapp', environment: 'test', version: 'test-release-1' },
        sdk: { name: '@grafana/faro-web-sdk', version: VERSION },
      });
      for (const id of ids) expect(body).not.toContain(id!);
      expect(body).not.toMatch(/private|session|userAgent|page_url|trace_id|user_id/);
    }
    for (const storage of [localStorage, sessionStorage]) {
      expect(storage.getItem).not.toHaveBeenCalled();
      // SDK import may probe storage availability, but never persists a session or our intake ID.
      for (const call of storage.setItem.mock.calls)
        expect(call).toEqual(['__faro_storage_test__', '__faro_storage_test__']);
      for (const id of ids) expect(JSON.stringify(storage.setItem.mock.calls)).not.toContain(id!);
    }
    expect(first.health().source_transport_failures).toBe(0);
    expect(second.health().source_transport_failures).toBe(0);
  });

  it('bounds the public SDK queue and starts each single-attempt timeout only after dequeue', async () => {
    vi.stubGlobal('window', new EventTarget());
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      (_url: string, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = options!.signal!;
          signals.push(signal);
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const sdkModule = await import('@grafana/faro-web-sdk');
    let instance!: Faro;
    const exporter = createEngineeringExporter(async () => ({
      ...sdkModule,
      initializeFaro: (config) => {
        instance = sdkModule.initializeFaro(config);
        return instance;
      },
    }));
    await exporter.initialize();
    // 使用公开 pause 隔离自动 health batch，只验证此处公开 send/queue 的容量。
    instance.pause();
    const transport = instance.transports.transports[0] as FetchTransport;
    const item: TransportItem = {
      type: sdkModule.TransportItemType.EVENT,
      meta: {},
      payload: { name: 'st_page_started', timestamp: '2026-10-29T00:00:00Z' },
    };
    const sending = Array.from({ length: 25 }, () => transport.send([item]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exporter.health().source_transport_failures).toBe(5);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(sending);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(exporter.health().source_transport_failures).toBe(25);
  });

  it('counts a body-format failure once without sending or escaping into the caller', async () => {
    vi.stubGlobal('window', new EventTarget());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sdkModule = await import('@grafana/faro-web-sdk');
    const exporter = createEngineeringExporter(async () => ({
      ...sdkModule,
      getTransportBody: () => {
        throw new Error('unserializable batch');
      },
    }));
    exporter.event('page.started', { route: '/' });
    await exporter.initialize();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(exporter.health().source_transport_failures).toBe(1);
  });

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
