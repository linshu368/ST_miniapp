import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDomainDb: vi.fn(),
}));

vi.mock('./supabase.js', () => ({
  getDomainDb: mocks.getDomainDb,
}));

import {
  clearDbUserIdentityCache,
  getOrCreateDbUser,
  USER_IDENTITY_CACHE_MAX_ENTRIES,
} from './user.js';
import type { TelegramUser } from '../middleware/auth.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function telegramUser(id: number): TelegramUser {
  return { id, first_name: `user-${id}` };
}

function userRow(tgId: string) {
  return {
    id: `db-${tgId}`,
    tg_id: tgId,
    source_id: null,
    bot_entered_at: null,
    miniapp_entered_at: '2026-10-27T00:00:00.000Z',
    total_round: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
  };
}

function installExistingUserDb(
  read: (tgId: string) => Promise<{ data: ReturnType<typeof userRow> | null; error: unknown }>
) {
  const maybeSingle = vi.fn((tgId: string) => read(tgId));
  mocks.getDomainDb.mockReturnValue({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn((_column: string, tgId: string) => ({
          abortSignal: vi.fn(() => ({
            maybeSingle: () => maybeSingle(tgId),
          })),
        })),
      })),
    })),
  });
  return maybeSingle;
}

describe('getOrCreateDbUser identity cache', () => {
  beforeEach(() => {
    clearDbUserIdentityCache();
    mocks.getDomainDb.mockReset();
    vi.restoreAllMocks();
  });

  it('collapses concurrent reads for the same Telegram user and exposes immutable identity only', async () => {
    const pending = deferred<{ data: ReturnType<typeof userRow>; error: null }>();
    const maybeSingle = installExistingUserDb(() => pending.promise);

    const first = getOrCreateDbUser(telegramUser(101));
    const second = getOrCreateDbUser(telegramUser(101));
    expect(maybeSingle).toHaveBeenCalledOnce();

    pending.resolve({ data: userRow('101'), error: null });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 'db-101', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'db-101', created_at: '2026-10-01T00:00:00.000Z' },
    ]);

    await expect(getOrCreateDbUser(telegramUser(101))).resolves.toEqual({
      id: 'db-101',
      created_at: '2026-10-01T00:00:00.000Z',
    });
    expect(maybeSingle).toHaveBeenCalledOnce();
  });

  it('keeps different users isolated', async () => {
    const maybeSingle = installExistingUserDb(async (tgId) => ({
      data: userRow(tgId),
      error: null,
    }));

    await expect(
      Promise.all([getOrCreateDbUser(telegramUser(201)), getOrCreateDbUser(telegramUser(202))])
    ).resolves.toEqual([
      { id: 'db-201', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'db-202', created_at: '2026-10-01T00:00:00.000Z' },
    ]);
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures and allows the next request to recover', async () => {
    const maybeSingle = installExistingUserDb(
      vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'temporary failure' } })
        .mockResolvedValueOnce({ data: userRow('301'), error: null })
    );

    await expect(getOrCreateDbUser(telegramUser(301))).rejects.toThrow(
      '查询 MiniApp 用户失败：temporary failure'
    );
    await expect(getOrCreateDbUser(telegramUser(301))).resolves.toEqual({
      id: 'db-301',
      created_at: '2026-10-01T00:00:00.000Z',
    });
    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('expires cached identities after the TTL', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const maybeSingle = installExistingUserDb(async (tgId) => ({
      data: userRow(tgId),
      error: null,
    }));

    await getOrCreateDbUser(telegramUser(401));
    now.mockReturnValue(61_001);
    await getOrCreateDbUser(telegramUser(401));

    expect(maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest identity when the cache reaches its capacity', async () => {
    const maybeSingle = installExistingUserDb(async (tgId) => ({
      data: userRow(tgId),
      error: null,
    }));

    for (let id = 1; id <= USER_IDENTITY_CACHE_MAX_ENTRIES + 1; id += 1) {
      await getOrCreateDbUser(telegramUser(id));
    }
    await getOrCreateDbUser(telegramUser(1));

    expect(maybeSingle).toHaveBeenCalledTimes(USER_IDENTITY_CACHE_MAX_ENTRIES + 2);
  });
});
