import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRouteRepositories } from './conversation-route-shared.js';
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  list: vi.fn(),
  owner: vi.fn(),
  recover: vi.fn(),
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
  mocks.list.mockResolvedValue({ messages: [], hasMore: false });
  registerConversationDetail(app, {
    sessions: { requireSession: mocks.owner, getCharacterFirstMes: async () => '' },
    history: { recoverStaleStreaming: mocks.recover, listMessages: mocks.list },
    settings: { getDisplayName: async () => 'Fixture' },
  } as unknown as ConversationRouteRepositories);
});
afterEach(async () => {
  await app.close();
});

describe('conversation detail cancellation boundary', () => {
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
