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
import { currentContext, newContext, withContext } from '../platform/observability/context.js';

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
  // enter_user RPC 一次返回整行（数据库重组 3a）。
  mocks.getDomainDb.mockReturnValue({
    rpc: vi.fn((_name: string, args: { p_tg_id: string }) => ({
      abortSignal: vi.fn(() => maybeSingle(args.p_tg_id)),
    })),
  });
  return maybeSingle;
}

describe('getOrCreateDbUser identity cache', () => {
  it('binds every inflight waiter and cache hit in its own request without extra reads', async () => {
    const pending = deferred<{ data: ReturnType<typeof userRow>; error: null }>();
    const read = installExistingUserDb(() => pending.promise);
    const userId = '11111111-1111-4111-8111-111111111111';
    const roots = [newContext('first'), newContext('waiter'), newContext('cache')];
    const run = (index: number) =>
      withContext(roots[index]!, async () => {
        await getOrCreateDbUser(telegramUser(101));
        expect(currentContext()?.business?.user_id).toBe(userId);
      });
    const first = run(0);
    const waiter = run(1);
    pending.resolve({ data: { ...userRow('101'), id: userId }, error: null });
    await Promise.all([first, waiter]);
    await run(2);
    expect(read).toHaveBeenCalledOnce();
    expect(new Set(roots.map((root) => root.business)).size).toBe(3);
    expect(currentContext()).toBeUndefined();
  });

  it('does not bind an internal user when identity resolution fails', async () => {
    installExistingUserDb(async () => ({ data: null, error: { message: 'read failed' } }));
    await withContext(newContext(), async () => {
      await expect(getOrCreateDbUser(telegramUser(102))).rejects.toThrow();
      expect(currentContext()?.business).not.toHaveProperty('user_id');
    });
  });
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
