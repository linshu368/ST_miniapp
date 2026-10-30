import type { BrowserConfig, Faro, FetchTransport, TransportItem } from '@grafana/faro-web-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEngineeringExporter } from './grafana';

const environment = vi.hoisted(() => ({ launchParams: vi.fn(), setTag: vi.fn() }));
vi.mock('@telegram-apps/sdk-react', () => ({ retrieveLaunchParams: environment.launchParams }));
vi.mock('@sentry/nextjs', () => ({ setTag: environment.setTag }));

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
    environment.launchParams.mockReturnValue({ tgWebAppPlatform: 'android' });
    environment.setTag.mockClear();
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g' } });
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
    exporter.measurement('page.critical_visual', 456, {
      route: '/characters',
      stage: 'critical_visual',
      outcome: 'loaded',
      cache: 'cache',
      source_measurement_version: 'critical_visual_v1',
    });
    exporter.event('page.critical_visual_terminal', {
      route: '/characters',
      stage: 'critical_visual',
      outcome: 'loaded',
    });
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
          tg_platform: 'android',
          schema_version: '1',
          measurement_version: 'engineering_v1',
        },
      })
    );
    expect(fake.measurement).toHaveBeenCalledWith(
      { type: 'st_page_critical_visual', values: { duration_ms: 456 } },
      expect.objectContaining({
        context: expect.objectContaining({
          route: '/characters',
          stage: 'critical_visual',
          outcome: 'loaded',
          cache: 'cache',
          source_measurement_version: 'critical_visual_v1',
        }),
      })
    );
    expect(fake.event).toHaveBeenCalledWith(
      'st_page_critical_visual_terminal',
      expect.objectContaining({ stage: 'critical_visual', outcome: 'loaded' }),
      'st.engineering',
      expect.anything()
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

  it('keeps unified drama diagnostics finite and strips observation identity at both boundaries', async () => {
    const fake = fakeSdk();
    const exporter = createEngineeringExporter(async () => fake.sdk);
    exporter.measurement('drama.diagnostic', 120, {
      route: '/',
      stage: 'network_ttfb_first',
      source_measurement_version: 'drama_v3',
      network_status: 'available',
      report_kind: 'final',
      observation_id: 'PRIVATE_ID',
    });
    exporter.event('drama.diagnostic', {
      route: '/',
      network_status: 'unsupported',
      event_order: 'anomaly',
      list_start_kind: 'document_navigation',
      video_url: 'PRIVATE_URL',
    });
    await exporter.initialize();
    expect(fake.measurement).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'st_drama_diagnostic' }),
      expect.objectContaining({
        context: expect.objectContaining({
          source_measurement_version: 'drama_v3',
          stage: 'network_ttfb_first',
        }),
      })
    );
    const config = fake.initialize.mock.calls[0]![0];
    const sanitized = config.beforeSend!({
      type: 'event',
      meta: { user: { id: 'PRIVATE_ID' } },
      payload: {
        name: 'st_drama_diagnostic',
        timestamp: '2026-10-29T00:00:00Z',
        attributes: {
          route: '/',
          source_measurement_version: 'drama_v3',
          network_status: 'available',
          list_start_kind: 'document_navigation',
          observation_id: 'PRIVATE_ID',
          video_url: 'PRIVATE_URL',
        },
      },
    } as TransportItem);
    expect(sanitized).toMatchObject({
      payload: {
        attributes: { network_status: 'available', list_start_kind: 'document_navigation' },
      },
    });
    expect(
      JSON.stringify([sanitized, fake.measurement.mock.calls, fake.event.mock.calls])
    ).not.toContain('PRIVATE_');
  });

  it('adds finite platform/network dimensions to every signal kind without copying browser identity', async () => {
    const fake = fakeSdk();
    const exporter = createEngineeringExporter(async () => fake.sdk);
    vi.stubGlobal('navigator', {
      connection: { effectiveType: '3g' },
      userAgent: 'PRIVATE_BROWSER_IDENTITY',
      hardwareConcurrency: 12,
    });
    for (const name of ['page.ready', 'roleplay.first_token', 'drama.startup', 'api.total']) {
      exporter.measurement(name, 100);
    }
    for (const name of ['page.terminal', 'roleplay.terminal', 'drama.terminal', 'api.terminal']) {
      exporter.event(name, { outcome: 'error' });
    }
    await exporter.initialize();
    for (const [, options] of fake.measurement.mock.calls)
      expect(options.context).toMatchObject({ net_type: '3g', tg_platform: 'android' });
    // Includes the exporter's own health event, not only owner-emitted events.
    for (const [, attributes] of fake.event.mock.calls)
      expect(attributes).toMatchObject({ net_type: '3g', tg_platform: 'android' });
    expect(JSON.stringify([fake.measurement.mock.calls, fake.event.mock.calls])).not.toMatch(
      /PRIVATE_|userAgent|hardwareConcurrency/
    );
  });

  it('freezes dimensions before SDK queueing and preserves an explicit owner window snapshot', async () => {
    const fake = fakeSdk();
    let resolveSdk!: (sdk: typeof fake.sdk) => void;
    const exporter = createEngineeringExporter(
      () =>
        new Promise((resolve) => {
          resolveSdk = resolve;
        })
    );
    exporter.measurement('roleplay.first_token', 100);
    vi.stubGlobal('navigator', { connection: { effectiveType: '3g' } });
    exporter.event('roleplay.terminal');
    exporter.event('drama.playback_window', {
      playing_ms: 18_000,
      rebuffer_ms: 2_000,
      net_type: 'mixed',
      tg_platform: 'ios',
      stage: 'playback',
      report_kind: 'playback',
      source_measurement_version: 'drama_playback_v1',
    });
    await Promise.resolve();
    resolveSdk(fake.sdk);
    await exporter.initialize();
    expect(fake.measurement.mock.calls[0]![1].context.net_type).toBe('4g');
    expect(
      fake.event.mock.calls.find(([name]) => name === 'st_roleplay_terminal')![1].net_type
    ).toBe('3g');
    const windowAttributes = fake.event.mock.calls.find(
      ([name]) => name === 'st_drama_playback_window'
    )![1];
    expect(windowAttributes).toMatchObject({
      playing_ms: '18000',
      rebuffer_ms: '2000',
      net_type: 'mixed',
      tg_platform: 'ios',
      stage: 'playback',
      report_kind: 'playback',
      source_measurement_version: 'drama_playback_v1',
    });
    const config = fake.initialize.mock.calls[0]![0];
    const item = {
      type: 'measurement',
      meta: {},
      payload: {
        type: 'st_roleplay_first_token',
        timestamp: '',
        values: { duration_ms: 100 },
        context: fake.measurement.mock.calls[0]![1].context,
      },
    } as TransportItem;
    expect(config.beforeSend!(item)).toMatchObject({ payload: { context: { net_type: '4g' } } });
  });

  it('keeps arbitrary dimensions and numeric fields out of ordinary signals', async () => {
    const fake = fakeSdk();
    const exporter = createEngineeringExporter(async () => fake.sdk);
    exporter.event('page.terminal', {
      tg_platform: 'PRIVATE_DEVICE',
      net_type: 'PRIVATE_NETWORK',
      playing_ms: 18_000,
      rebuffer_ms: 2_000,
      arbitrary_ms: 123,
    });
    await exporter.initialize();
    const attributes = fake.event.mock.calls.find(([name]) => name === 'st_page_terminal')![1];
    expect(attributes).toMatchObject({ tg_platform: 'other', net_type: 'other' });
    expect(attributes).not.toHaveProperty('playing_ms');
    expect(attributes).not.toHaveProperty('rebuffer_ms');
    expect(attributes).not.toHaveProperty('arbitrary_ms');
    expect(JSON.stringify(attributes)).not.toContain('PRIVATE_');
  });

  it.each([
    { playing_ms: 1 },
    { rebuffer_ms: 1 },
    { playing_ms: 0, rebuffer_ms: 0 },
    { playing_ms: -1, rebuffer_ms: 1 },
    { playing_ms: 60_001, rebuffer_ms: 0 },
    { playing_ms: 30_001, rebuffer_ms: 30_000 },
    { playing_ms: 1.5, rebuffer_ms: 0 },
    { playing_ms: true, rebuffer_ms: 1 },
    { playing_ms: NaN, rebuffer_ms: 1 },
    { playing_ms: 1, rebuffer_ms: Infinity },
    { playing_ms: '1.5', rebuffer_ms: '0' },
    { playing_ms: 'PRIVATE_VALUE', rebuffer_ms: '1' },
  ])(
    'rejects the entire invalid playback pair at enqueue and beforeSend: %o',
    async (attributes) => {
      const fake = fakeSdk();
      const exporter = createEngineeringExporter(async () => fake.sdk);
      exporter.event('drama.playback_window', attributes);
      await exporter.initialize();
      expect(exporter.health().source_invalid).toBe(1);
      expect(fake.event.mock.calls.some(([name]) => name === 'st_drama_playback_window')).toBe(
        false
      );
      const config = fake.initialize.mock.calls[0]![0];
      expect(
        config.beforeSend!({
          type: 'event',
          meta: {},
          payload: {
            name: 'st_drama_playback_window',
            timestamp: '',
            attributes,
          },
        } as TransportItem)
      ).toBeNull();
    }
  );

  it('retains both bounded playback durations while stripping private fields again before transport', async () => {
    const fake = fakeSdk();
    const exporter = createEngineeringExporter(async () => fake.sdk);
    await exporter.initialize();
    const config = fake.initialize.mock.calls[0]![0];
    for (const [playing, rebuffer] of [
      [60_000, 0],
      [0, 60_000],
      [18_000, 2_000],
    ]) {
      const item = {
        type: 'event',
        meta: { user: { id: 'PRIVATE_USER' } },
        payload: {
          name: 'st_drama_playback_window',
          timestamp: '',
          attributes: {
            playing_ms: String(playing),
            rebuffer_ms: String(rebuffer),
            user_id: 'PRIVATE_USER',
            video_url: 'PRIVATE_URL',
            net_type: 'mixed',
            tg_platform: 'ios',
            arbitrary_ms: 33,
          },
        },
      } as TransportItem;
      const sanitized = config.beforeSend!(item);
      expect(sanitized).toMatchObject({
        payload: {
          attributes: {
            playing_ms: String(playing),
            rebuffer_ms: String(rebuffer),
            net_type: 'mixed',
            tg_platform: 'ios',
          },
        },
      });
      expect(JSON.stringify(sanitized)).not.toMatch(/PRIVATE_|user_id|video_url|arbitrary_ms/);
    }
  });

  it('reads Telegram dimensions without Sentry initialization and normalizes unsupported network/platform values', async () => {
    vi.resetModules();
    environment.launchParams.mockReturnValue({ tgWebAppPlatform: 'ios' });
    const dimensions = await import('./env-tags');
    expect(dimensions.getMetricDimensions()).toEqual({ tg_platform: 'ios', net_type: '4g' });
    expect(environment.setTag).not.toHaveBeenCalled();
    environment.launchParams.mockReturnValue({ tgWebAppPlatform: 'PRIVATE_PLATFORM' });
    vi.stubGlobal('navigator', { connection: { effectiveType: 'PRIVATE_NETWORK' } });
    vi.resetModules();
    const unknownDimensions = await import('./env-tags');
    expect(unknownDimensions.getMetricDimensions()).toEqual({
      tg_platform: 'unknown',
      net_type: 'unknown',
    });
    expect(environment.setTag).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', {
      connection: {
        get effectiveType() {
          throw new Error('Network information unavailable');
        },
      },
    });
    expect(unknownDimensions.getNetworkTags()).toEqual({
      net_type: 'unknown',
      net_rtt_bucket: 'unknown',
    });
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
