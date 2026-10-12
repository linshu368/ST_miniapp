import { describe, expect, it, vi } from 'vitest';
import {
  withSessionAdvisoryLock,
  type SessionAdvisoryLockClient,
} from './postgres-advisory-lease.js';

function client(responses: Array<{ locked?: boolean; unlocked?: boolean }>): {
  client: SessionAdvisoryLockClient;
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockImplementation(async () => ({ rows: [responses.shift() ?? {}] }));
  const end = vi.fn().mockResolvedValue(undefined);
  return { client: { connect, query, end }, connect, query, end };
}

describe('withSessionAdvisoryLock', () => {
  it('acquires and releases the lease through the same dedicated client', async () => {
    const fake = client([{ locked: true }, { unlocked: true }]);
    const work = vi.fn().mockResolvedValue('done');

    await expect(
      withSessionAdvisoryLock(731_006, work, { createClient: () => fake.client })
    ).resolves.toEqual({ acquired: true, value: 'done' });

    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [731_006]
    );
    expect(fake.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
      [731_006]
    );
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('skips work and only closes the client when another replica holds the lock', async () => {
    const fake = client([{ locked: false }]);
    const work = vi.fn();

    await expect(
      withSessionAdvisoryLock(731_006, work, { createClient: () => fake.client })
    ).resolves.toEqual({ acquired: false });

    expect(work).not.toHaveBeenCalled();
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.end).toHaveBeenCalledOnce();
  });

  it('releases and closes the lease when the monitoring round fails', async () => {
    const fake = client([{ locked: true }, { unlocked: true }]);
    const failure = new Error('monitor failed');

    await expect(
      withSessionAdvisoryLock(
        731_006,
        async () => {
          throw failure;
        },
        { createClient: () => fake.client }
      )
    ).rejects.toBe(failure);

    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.end).toHaveBeenCalledOnce();
  });
});
