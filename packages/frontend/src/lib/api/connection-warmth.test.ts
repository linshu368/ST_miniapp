import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectionVerifiedAgeMs,
  resetConnectionWarmthForTest,
  warmApiConnection,
} from './connection-warmth';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  fetchMock.mockReset().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  resetConnectionWarmthForTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('warmApiConnection', () => {
  it('calls only the database-free health route, without credentials or custom headers', () => {
    expect(warmApiConnection()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/health$/);
    expect(init).not.toHaveProperty('headers');
    expect(init).not.toHaveProperty('credentials');
  });

  it('limits itself to one ping per interval', async () => {
    expect(warmApiConnection()).toBe(true);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(warmApiConnection()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(warmApiConnection()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never stacks a second ping on a hung connection, and aborts the hung one', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal!;
          signal.addEventListener('abort', () => reject(signal!.reason));
        })
    );
    warmApiConnection();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(warmApiConnection()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(warmApiConnection()).toBe(true);
  });

  it('swallows network failures without claiming the connection works', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(warmApiConnection()).toBe(true);
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.toBeDefined();
    expect(connectionVerifiedAgeMs()).toBeNull();
  });

  it('reports how long ago the connection was proven to work', async () => {
    warmApiConnection();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connectionVerifiedAgeMs()).toBe(10_000);
  });
});
