import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfigEntry } from '../../platform/runtime-config.js';
import { TEXT_POSTPROCESS_CONFIG_KEY } from './constants.js';
import { readAdminPostprocessVersion, TextPostprocessVersionCache } from './config.js';

function entry(value: unknown, version = 4): RuntimeConfigEntry {
  return { value, textValue: null, version };
}

const published = {
  version: 4,
  schema_version: 1,
  policy_version: 1,
  source: { schema_version: 1, policy_version: 1, rules: [] },
  published_at: '2026-09-28T00:00:00.000Z',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('TextPostprocessVersionCache', () => {
  it('warms a published version before the first request', async () => {
    const keys: string[] = [];
    const cache = new TextPostprocessVersionCache({
      read: async (key) => {
        keys.push(key);
        return entry(published);
      },
    });

    await expect(cache.warm()).resolves.toBe(4);
    expect(cache.current()).toBe(4);
    expect(keys).toEqual([TEXT_POSTPROCESS_CONFIG_KEY]);
  });

  it('treats a confirmed missing row as an enabled Markdown fallback', async () => {
    const cache = new TextPostprocessVersionCache({ read: async () => null });

    await expect(cache.warm()).resolves.toBeNull();
    expect(cache.current()).toBeNull();
  });

  it('keeps the last valid version when refresh sees invalid config or a read failure', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(entry(published))
      .mockResolvedValueOnce(entry({ ...published, schema_version: 2 }))
      .mockRejectedValueOnce(new Error('db down'));
    const cache = new TextPostprocessVersionCache({ read });

    await cache.warm();
    await cache.refresh();
    expect(cache.current()).toBe(4);
    await cache.refresh();
    expect(cache.current()).toBe(4);
  });

  it('times out a cold refresh without blocking chat and preserves a primed version', async () => {
    const signals: AbortSignal[] = [];
    const cache = new TextPostprocessVersionCache({
      timeoutMs: 10,
      read: (_key, signal) => {
        if (signal) signals.push(signal);
        return new Promise(() => undefined);
      },
    });

    await expect(cache.warm()).resolves.toBeNull();
    expect(signals[0]?.aborted).toBe(true);

    cache.prime(7);
    await cache.refresh();
    expect(cache.current()).toBe(7);
  });

  it('deduplicates concurrent refreshes and periodically refreshes in the background', async () => {
    vi.useFakeTimers();
    let release: ((value: RuntimeConfigEntry) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<RuntimeConfigEntry>((resolve) => {
          release = resolve;
        })
    );
    const cache = new TextPostprocessVersionCache({ read, refreshIntervalMs: 20 });

    const first = cache.refresh();
    const second = cache.refresh();
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    release?.(entry(published));
    await first;

    cache.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(read).toHaveBeenCalledTimes(2);
    const background = cache.refresh();
    release?.(entry({ ...published, version: 5 }, 5));
    await background;
    expect(cache.current()).toBe(5);
    cache.stop();
  });
});

describe('readAdminPostprocessVersion', () => {
  it('returns null for an illegal payload instead of substituting another version', async () => {
    await expect(
      readAdminPostprocessVersion(1_000, async () => entry({ ...published, policy_version: 9 }))
    ).resolves.toBeNull();
  });

  it('fails an admin config read on timeout instead of pretending nothing is published', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      readAdminPostprocessVersion(10, (_key, nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined);
      })
    ).rejects.toThrow(/timed out/);
    expect(signal?.aborted).toBe(true);
  });
});
