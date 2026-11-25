import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRouteRepositories } from './conversation-route-shared.js';
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  list: vi.fn(),
  owner: vi.fn(),
  recover: vi.fn(),
  names: vi.fn(),
  opening: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    if (request.headers['x-test-auth'] !== 'missing')
      request.user = { id: 123, first_name: 'Fixture' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/conversations/index.js', async () => ({
  ...(await import('../features/conversations/errors.js')),
  ...(await import('../features/conversations/user-placeholder.js')),
}));
import { registerConversationDetail } from './conversation-detail.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
let app: FastifyInstance;
let errors: unknown[];
let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  errors = [];
  logs = [];
  app = Fastify({ logger: { stream: { write: (line: string) => logs.push(line) } } });
  app.setErrorHandler((error, _request, reply) => {
    errors.push(error);
    void reply.status(500).send({ error: 'fixture' });
  });
  mocks.user.mockResolvedValue({ id: 'fixture-owner' });
  mocks.owner.mockResolvedValue({ id: SESSION, character_id: 'fixture-character' });
  mocks.recover.mockResolvedValue(undefined);
  mocks.names.mockResolvedValue('Fixture');
  mocks.opening.mockResolvedValue('');
  mocks.list.mockResolvedValue({ messages: [], hasMore: false });
  registerConversationDetail(app, {
    sessions: { requireSession: mocks.owner, getCharacterFirstMes: mocks.opening },
    history: { recoverStaleStreaming: mocks.recover, listMessages: mocks.list },
    settings: { getDisplayName: mocks.names },
  } as unknown as ConversationRouteRepositories);
});
afterEach(async () => {
  await app.close();
});

describe('conversation detail cancellation boundary', () => {
  it('starts the history page without waiting for names or opening, but does not respond before access succeeds', async () => {
    let names!: (value: string) => void;
    let opening!: (value: string) => void;
    mocks.names.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          names = resolve;
        })
    );
    mocks.opening.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          opening = resolve;
        })
    );
    let finished = false;
    const response = app.inject(`/api/v1/conversations/${SESSION}`).then((value) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    opening('fixture opening');
    await Promise.resolve();
    expect(finished).toBe(false);
    names('Fixture');
    expect((await response).statusCode).toBe(200);
  });

  it('bounds identity and all dependent phases by one eight-second server deadline', async () => {
    await app.ready();
    vi.useFakeTimers();
    let resolveIdentity!: (value: { id: string }) => void;
    mocks.user.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        })
    );
    try {
      const response = app.inject(`/api/v1/conversations/${SESSION}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.user).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await response).statusCode).toBe(500);
      expect(errors[0]).toMatchObject({ name: 'TimeoutError' });
      resolveIdentity({ id: 'fixture-owner' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.owner).not.toHaveBeenCalled();
      expect(mocks.recover).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['entry', 'poll', 'refresh', 'older'])(
    'returns %s history even when stale recovery is unavailable',
    async (purpose) => {
      mocks.recover.mockImplementation(() => {
        throw new Error('fixture recovery unavailable');
      });
      const message = {
        id: 'fixture-message',
        session_id: SESSION,
        role: 'assistant',
        status: 'streaming',
        revision: 1,
        turn_index: 8,
        content: '已保存的预览',
      };
      mocks.list.mockResolvedValue({ messages: [message], hasMore: true });
      const pagination = purpose === 'older' ? '&before_turn_index=9' : '&limit=6';
      const response = await app.inject(
        `/api/v1/conversations/${SESSION}?read_purpose=${purpose}${pagination}`
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        data: { messages: [message], has_more: true },
      });
      expect(mocks.list).toHaveBeenCalledExactlyOnceWith(
        SESSION,
        expect.any(Promise),
        expect.objectContaining({
          userId: 'fixture-owner',
          limit: purpose === 'older' ? undefined : 6,
          beforeTurnIndex: purpose === 'older' ? 9 : undefined,
        })
      );
      expect(mocks.recover).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    }
  );

  it('retains a failed role/access check even when the historical page already succeeded', async () => {
    const failure = new Error('fixture role unavailable');
    mocks.opening.mockRejectedValue(failure);
    expect((await app.inject(`/api/v1/conversations/${SESSION}`)).statusCode).toBe(500);
    expect(errors).toEqual([failure]);
    const summary = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'conversation.detail.failed');
    expect(summary?.failed_stage).toBe('opening');
    expect(summary?.failure_kind).toBe('dependency_failed');
  });
  it('lets shared identity finish but starts no further reads after disconnect', async () => {
    const caller = new AbortController();
    let resolveIdentity!: (value: { id: string }) => void;
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    app.addHook('onRequest', (_request, reply, done) => {
      reply.raw.once('close', closed);
      done();
    });
    mocks.user.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        })
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const reading = fetch(`${address}/api/v1/conversations/${SESSION}`, { signal: caller.signal });
    const rejected = expect(reading).rejects.toThrow();
    await vi.waitFor(() => expect(mocks.user).toHaveBeenCalledOnce());
    caller.abort();
    await Promise.all([rejected, connectionClosed]);
    resolveIdentity({ id: 'fixture-owner' });
    await vi.waitFor(() =>
      expect(logs.some((line) => line.includes('conversation.detail.cancelled'))).toBe(true)
    );
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
  it('ends an actual closed connection without reporting a false 500', async () => {
    const caller = new AbortController();
    mocks.list.mockImplementation((_id, _opening, options: { signal: AbortSignal }) => {
      caller.abort();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${address}/api/v1/conversations/${SESSION}`, { signal: caller.signal })
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(logs.filter((line) => line.includes('conversation.detail.cancelled'))).toHaveLength(1)
    );
    expect(errors).toEqual([]);
    expect(logs.some((line) => line.includes('conversation.detail.failed'))).toBe(false);
  });

  it.each(['AbortError', 'TimeoutError', 'Error'])(
    'preserves independent %s failures',
    async (name) => {
      const failure = new Error('fixture dependency failure');
      failure.name = name;
      mocks.list.mockRejectedValue(failure);
      expect((await app.inject(`/api/v1/conversations/${SESSION}`)).statusCode).toBe(500);
      expect(errors).toEqual([failure]);
    }
  );

  it('does not turn identity failure into a cancellation or start history reads', async () => {
    const failure = new Error('fixture identity failure');
    mocks.user.mockRejectedValue(failure);
    expect((await app.inject(`/api/v1/conversations/${SESSION}`)).statusCode).toBe(500);
    expect(errors).toEqual([failure]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('retains ownership denial and auth validation', async () => {
    mocks.owner.mockRejectedValue(new ConversationRepositoryError('session_not_found', 'fixture'));
    expect((await app.inject(`/api/v1/conversations/${SESSION}`)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v1/conversations/${SESSION}`,
          headers: { 'x-test-auth': 'missing' },
        })
      ).statusCode
    ).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});
