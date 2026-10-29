import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectDramaDelivery, dramaExperimentUser } from '../features/drama/delivery.js';

const mocks = vi.hoisted(() => ({
  getDomainDb: vi.fn(),
  config: {
    database: { target: 'test' as 'test' | 'production' },
    supabase: { url: 'https://zoqelpfhurwehlvypryl.supabase.co' },
  },
}));

vi.mock('./config.js', () => ({ config: mocks.config }));

vi.mock('../lib/supabase.js', () => ({
  getDomainDb: mocks.getDomainDb,
}));

import {
  getDramaPlaybackCdnConfig,
  clearRuntimeConfigInflightReads,
  fetchRuntimeConfigEntries,
  fetchRuntimeConfigEntry,
  fetchRuntimeConfigEntryStrict,
} from './runtime-config.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function row(key: string, version = 1) {
  return { key, value: { key }, text_value: null, version };
}

function installRuntimeConfigDb(input: {
  readEntry?: (key: string) => Promise<{ data: ReturnType<typeof row> | null; error: unknown }>;
  readEntries?: (
    keys: readonly string[]
  ) => Promise<{ data: Array<ReturnType<typeof row>> | null; error: unknown }>;
}) {
  const readEntry = vi.fn(
    input.readEntry ?? (async (key: string) => ({ data: row(key), error: null }))
  );
  const readEntries = vi.fn(
    input.readEntries ??
      (async (keys: readonly string[]) => ({ data: keys.map((key) => row(key)), error: null }))
  );

  mocks.getDomainDb.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn((_column: string, key: string) => {
          const result = () => readEntry(key);
          return {
            maybeSingle: result,
            abortSignal: vi.fn(() => ({ maybeSingle: result })),
          };
        }),
        in: vi.fn((_column: string, keys: readonly string[]) => ({
          abortSignal: vi.fn(() => readEntries(keys)),
        })),
      })),
    })),
  });

  return { readEntry, readEntries };
}

describe('runtime config in-flight reads', () => {
  beforeEach(() => {
    clearRuntimeConfigInflightReads();
    mocks.getDomainDb.mockReset();
  });

  it('collapses concurrent non-strict reads for the same key', async () => {
    const pending = deferred<{ data: ReturnType<typeof row>; error: null }>();
    const { readEntry } = installRuntimeConfigDb({ readEntry: () => pending.promise });

    const first = fetchRuntimeConfigEntry('same-key');
    const second = fetchRuntimeConfigEntry('same-key');
    expect(readEntry).toHaveBeenCalledOnce();

    pending.resolve({ data: row('same-key'), error: null });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: { key: 'same-key' }, textValue: null, version: 1 },
      { value: { key: 'same-key' }, textValue: null, version: 1 },
    ]);
  });

  it('keeps strict and caller-cancellable reads independent', async () => {
    const { readEntry } = installRuntimeConfigDb({});
    const signalA = new AbortController().signal;
    const signalB = new AbortController().signal;

    await Promise.all([
      fetchRuntimeConfigEntry('key', signalA),
      fetchRuntimeConfigEntry('key', signalB),
      fetchRuntimeConfigEntryStrict('key'),
      fetchRuntimeConfigEntryStrict('key'),
    ]);

    expect(readEntry).toHaveBeenCalledTimes(4);
  });

  it('clears a failed single-key read so the next request can recover', async () => {
    const { readEntry } = installRuntimeConfigDb({
      readEntry: vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'temporary failure' } })
        .mockResolvedValueOnce({ data: row('recover'), error: null }),
    });

    await expect(fetchRuntimeConfigEntry('recover')).resolves.toBeNull();
    await expect(fetchRuntimeConfigEntry('recover')).resolves.toEqual({
      value: { key: 'recover' },
      textValue: null,
      version: 1,
    });
    expect(readEntry).toHaveBeenCalledTimes(2);
  });

  it('normalizes an identical key set and returns independent maps', async () => {
    const pending = deferred<{ data: Array<ReturnType<typeof row>>; error: null }>();
    const { readEntries } = installRuntimeConfigDb({ readEntries: () => pending.promise });

    const first = fetchRuntimeConfigEntries(['beta', 'alpha', 'alpha']);
    const second = fetchRuntimeConfigEntries(['alpha', 'beta']);
    expect(readEntries).toHaveBeenCalledOnce();
    expect(readEntries).toHaveBeenCalledWith(['alpha', 'beta']);

    pending.resolve({ data: [row('alpha'), row('beta')], error: null });
    const [firstMap, secondMap] = await Promise.all([first, second]);
    expect(firstMap).not.toBe(secondMap);
    expect([...firstMap.keys()]).toEqual(['alpha', 'beta']);
    firstMap.delete('alpha');
    expect(secondMap.has('alpha')).toBe(true);
  });

  it('clears a failed batch so the next request can recover', async () => {
    const { readEntries } = installRuntimeConfigDb({
      readEntries: vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'temporary failure' } })
        .mockResolvedValueOnce({ data: [row('recover')], error: null }),
    });

    await expect(fetchRuntimeConfigEntries(['recover'])).resolves.toEqual(new Map());
    const recovered = await fetchRuntimeConfigEntries(['recover']);

    expect(recovered.get('recover')).toEqual({
      value: { key: 'recover' },
      textValue: null,
      version: 1,
    });
    expect(readEntries).toHaveBeenCalledTimes(2);
  });

  it('does not merge different key sets or caller-cancellable batches', async () => {
    const { readEntries } = installRuntimeConfigDb({});

    await Promise.all([
      fetchRuntimeConfigEntries(['alpha']),
      fetchRuntimeConfigEntries(['beta']),
      fetchRuntimeConfigEntries(['alpha'], new AbortController().signal),
      fetchRuntimeConfigEntries(['alpha'], new AbortController().signal),
    ]);

    expect(readEntries).toHaveBeenCalledTimes(4);
  });
});

describe('drama CDN deployment boundary', () => {
  const originalTarget = mocks.config.database.target;
  const originalUrl = mocks.config.supabase.url;
  beforeEach(() => {
    vi.stubEnv('DRAMA_CDN_ENABLED', 'true');
    vi.stubEnv('DRAMA_CDN_TOKEN_KEY', 'fictional-key');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'pr-525');
    vi.stubEnv('DEV_AUTH_BYPASS', '0');
    vi.stubEnv('MOCK_AUTH', '0');
    mocks.config.database.target = 'test';
    mocks.config.supabase.url = 'https://zoqelpfhurwehlvypryl.supabase.co';
  });
  afterEach(() => {
    mocks.config.database.target = originalTarget;
    mocks.config.supabase.url = originalUrl;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('enables ordinary playback for pr-525 TEST without account or sample selectors', () => {
    expect(getDramaPlaybackCdnConfig()).toMatchObject({
      tokenKey: 'fictional-key',
      pathPrefix: '/preview-test',
      sourceOrigin: mocks.config.supabase.url,
    });
  });
  it('selects only the fixed Bunny cohort and restores its original route when disabled', () => {
    vi.stubEnv('DRAMA_CDN_EXPERIMENT_ID', 'unit-cohort');
    vi.stubEnv('DRAMA_CDN_EXPERIMENT_KEY', 'fictional-group-key-for-local-testing-only');
    const experiment = {
      id: 'unit-cohort',
      key: 'fictional-group-key-for-local-testing-only',
      environment: 'test' as const,
      enabled: true,
    };
    const ids = Array.from({ length: 100 }, (_, id) => id);
    const bunny = ids.find((id) => dramaExperimentUser(id, experiment).assigned_group === 'bunny')!;
    const control = ids.find(
      (id) => dramaExperimentUser(id, experiment).assigned_group === 'supabase'
    )!;
    expect(selectDramaDelivery(bunny)).toMatchObject({
      delivery: { group: 'bunny', provider: 'bunny', reason: 'assigned' },
      cdn: { pathPrefix: '/preview-test' },
    });
    expect(selectDramaDelivery(control)).toMatchObject({
      delivery: { group: 'supabase', provider: 'supabase' },
      cdn: null,
    });
    vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
    expect(selectDramaDelivery(bunny)).toMatchObject({
      delivery: { group: 'bunny', provider: 'supabase', reason: 'disabled' },
      cdn: null,
    });
  });
  it.each(['production', 'development', 'pr-526', ''])(
    'keeps Supabase for environment %s',
    (name) => {
      vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', name);
      expect(getDramaPlaybackCdnConfig()).toBeNull();
    }
  );
  it('keeps production data and disabled previews off Bunny', () => {
    mocks.config.database.target = 'production';
    expect(getDramaPlaybackCdnConfig()).toBeNull();
    mocks.config.database.target = 'test';
    vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
    expect(getDramaPlaybackCdnConfig()).toBeNull();
  });
  it('restores the original path when disabled even if experiment credentials are invalid', () => {
    vi.stubEnv('DRAMA_CDN_EXPERIMENT_ID', 'unit-cohort');
    vi.stubEnv('DRAMA_CDN_EXPERIMENT_KEY', '');
    expect(() => selectDramaDelivery(42)).toThrow('drama_experiment_config_invalid');
    vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
    expect(selectDramaDelivery(42)).toEqual({ cdn: null, delivery: undefined });
  });
  it('requires explicit production configuration and closes without discarding the cohort key', () => {
    mocks.config.database.target = 'production';
    mocks.config.supabase.url = 'https://wbtsfzozlmurljvglhpn.supabase.co';
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'production');
    vi.stubEnv('DRAMA_CDN_TOKEN_KEY', 'fictional-signing-key-for-local-testing-only');
    vi.stubEnv('DRAMA_CDN_EXPERIMENT_ID', 'unit-experiment');
    vi.stubEnv('DRAMA_CDN_EXPERIMENT_KEY', 'fictional-group-key-for-local-testing-only');
    expect(() => getDramaPlaybackCdnConfig()).toThrow();
    vi.stubEnv('DRAMA_CDN_BASE_URL', 'https://fictional-production.b-cdn.net');
    expect(getDramaPlaybackCdnConfig()).toMatchObject({
      pathPrefix: '/production',
      sourceOrigin: mocks.config.supabase.url,
    });
    mocks.config.supabase.url = originalUrl;
    expect(() => getDramaPlaybackCdnConfig()).toThrow();
    vi.stubEnv('DRAMA_CDN_ENABLED', 'false');
    expect(getDramaPlaybackCdnConfig()).toBeNull();
  });
  it('refuses invalid credentials, source or authentication bypass', () => {
    vi.stubEnv('DRAMA_CDN_TOKEN_KEY', '');
    expect(() => getDramaPlaybackCdnConfig()).toThrow('drama_cdn_config_invalid');
    vi.stubEnv('DRAMA_CDN_TOKEN_KEY', 'fictional-key');
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    expect(() => getDramaPlaybackCdnConfig()).toThrow('drama_cdn_config_invalid');
    vi.stubEnv('DEV_AUTH_BYPASS', '0');
    vi.stubEnv('MOCK_AUTH', '1');
    expect(() => getDramaPlaybackCdnConfig()).toThrow('drama_cdn_config_invalid');
    vi.stubEnv('MOCK_AUTH', '0');
    mocks.config.supabase.url = 'https://another.supabase.co';
    expect(() => getDramaPlaybackCdnConfig()).toThrow('drama_cdn_config_invalid');
  });
});
