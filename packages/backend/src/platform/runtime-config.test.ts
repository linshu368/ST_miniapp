import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDomainDb: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  getDomainDb: mocks.getDomainDb,
}));

import {
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
