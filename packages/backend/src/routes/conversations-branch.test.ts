import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';

const SOURCE = '11111111-2222-4333-8444-555555555555';
const BRANCH = '11111111-2222-4333-8444-555555555556';
const MESSAGE = '11111111-2222-4333-8444-555555555557';
const REQUEST = '11111111-2222-4333-8444-555555555558';
const USER = '11111111-2222-4333-8444-555555555559';
const CHARACTER = '11111111-2222-4333-8444-55555555555a';
const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  user: vi.fn(),
  limits: vi.fn(),
  list: vi.fn(),
  opening: vi.fn(),
  displayName: vi.fn(),
  runTurn: vi.fn(),
  setLike: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    if (request.headers['x-test-auth'] !== 'missing')
      request.user = { id: 12345, first_name: 'Tester' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/conversations/context-window.js', () => ({
  fetchContextWindowLimits: mocks.limits,
}));
vi.mock('../infrastructure/repositories/ChatSessionRepository.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../infrastructure/repositories/ChatSessionRepository.js')
  >()),
  ChatSessionRepository: class {
    forkSession = mocks.fork;
    getCharacterFirstMes = mocks.opening;
  },
}));
vi.mock('../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {
    listMessages = mocks.list;
    setMessageLike = mocks.setLike;
  },
  toChatMessages: () => [],
}));
vi.mock('../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {
    getDisplayName = mocks.displayName;
  },
}));
vi.mock('../features/conversations/index.js', async () => ({
  ...(await import('../features/conversations/errors.js')),
  ...(await import('../features/conversations/user-placeholder.js')),
  createReplyStreamSink: vi.fn(),
  runConversationTurn: mocks.runTurn,
  withConversationPreparationDeadline: (work: Promise<unknown>) => work,
}));

const inherited: ChatMessage = {
  id: MESSAGE,
  session_id: BRANCH,
  turn_index: 20,
  revision: 1,
  role: 'assistant',
  content: '「{{user}}，从这里继续吧。」[memory]山谷里的约定[/memory]',
  inherited: true,
  status: 'complete',
  error_code: null,
  finish_reason: 'stop',
  model_id: 'test/model',
  postprocess_version: 4,
  created_at: '2026-10-28T10:00:00Z',
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.user.mockResolvedValue({ id: USER });
  mocks.limits.mockResolvedValue({ maxTurns: 75, retainTurns: 50 });
  mocks.displayName.mockResolvedValue('小林');
  mocks.opening.mockResolvedValue('开场白');
  mocks.fork.mockResolvedValue({
    id: BRANCH,
    user_id: USER,
    character_id: CHARACTER,
    title: '林间旅人 · 分支',
    last_message_at: '2026-10-29T10:00:00Z',
    last_message_preview: '「从这里继续吧。」',
    message_count: 40,
    pinned_at: null,
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-29T10:00:00Z',
    branch_source_session_id: SOURCE,
    branch_source_turn_index: 20,
    branch_inherited_turns: 20,
  });
  mocks.list.mockResolvedValue({ messages: [inherited], hasMore: false });
  mocks.setLike.mockImplementation(async ({ sessionId, messageId, liked }) => ({
    session_id: sessionId,
    message_id: messageId,
    liked,
  }));
});

afterEach(() => {
  expect(
    mocks.runTurn,
    'branching and reply likes must not generate or charge'
  ).not.toHaveBeenCalled();
});

describe('conversation reply like boundary', () => {
  const url = `/api/v1/conversations/${SOURCE}/messages/${MESSAGE}/like`;

  it('requires authentication before writing feedback', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url,
        payload: { liked: true },
        headers: { 'x-test-auth': 'missing' },
      });
      expect(response.statusCode).toBe(401);
      expect(mocks.user).not.toHaveBeenCalled();
      expect(mocks.setLike).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([{}, { liked: 'true' }, { liked: 1 }, { liked: null }, { liked: true, user_id: USER }])(
    'rejects invalid feedback %j before database work',
    async (payload) => {
      const app = await buildApp();
      try {
        const response = await app.inject({ method: 'PUT', url, payload });
        expect(response.statusCode).toBe(400);
        expect(mocks.user).not.toHaveBeenCalled();
        expect(mocks.setLike).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    `/api/v1/conversations/invalid/messages/${MESSAGE}/like`,
    `/api/v1/conversations/${SOURCE}/messages/opening:session/like`,
  ])('rejects nonpersistent conversation or reply ids', async (invalidUrl) => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: invalidUrl,
        payload: { liked: true },
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.setLike).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([true, false])('passes the explicit target %s and authenticated owner', async (liked) => {
    const app = await buildApp();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({ method: 'PUT', url, payload: { liked } });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({
          success: true,
          data: { session_id: SOURCE, message_id: MESSAGE, liked },
        });
      }
      expect(mocks.setLike).toHaveBeenNthCalledWith(1, {
        userId: USER,
        sessionId: SOURCE,
        messageId: MESSAGE,
        liked,
      });
      expect(mocks.setLike.mock.calls[1]).toEqual(mocks.setLike.mock.calls[0]);
      expect(mocks.limits).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ['session_not_found', 404],
    ['reply_like_not_allowed', 409],
  ] as const)('returns %s without private repository details', async (code, status) => {
    mocks.setLike.mockRejectedValue(new ConversationRepositoryError(code, 'private reply detail'));
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'PUT', url, payload: { liked: true } });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain('private reply detail');
    } finally {
      await app.close();
    }
  });

  it('allows a manual retry of the same target after an uncertain failure', async () => {
    mocks.setLike.mockRejectedValueOnce(new Error('database private payload'));
    const app = await buildApp();
    try {
      const request = { method: 'PUT' as const, url, payload: { liked: true } };
      const failed = await app.inject(request);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('database private payload');
      const retried = await app.inject(request);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().data.liked).toBe(true);
      expect(mocks.setLike.mock.calls[1]).toEqual(mocks.setLike.mock.calls[0]);
    } finally {
      await app.close();
    }
  });
});

async function buildApp() {
  const { default: routes } = await import('./conversations.js');
  const app = Fastify({ logger: false });
  await app.register(routes);
  await app.ready();
  return app;
}

const payload = { message_id: MESSAGE, request_id: REQUEST };

describe('conversation branch boundary', () => {
  it('requires authentication before reading configuration or a conversation', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${SOURCE}/branch`,
        payload,
        headers: { 'x-test-auth': 'missing' },
      });
      expect(response.statusCode).toBe(401);
      expect(mocks.user).not.toHaveBeenCalled();
      expect(mocks.fork).not.toHaveBeenCalled();
      expect(mocks.limits).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    {},
    { ...payload, message_id: 'opening:session' },
    { ...payload, request_id: null },
    { ...payload, retain_turns: 9999 },
    { ...payload, user_id: USER },
  ])('rejects invalid or client-owned configuration %j', async (body) => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${SOURCE}/branch`,
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.user).not.toHaveBeenCalled();
      expect(mocks.fork).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid source id before any database work', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations/not-a-uuid/branch',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.fork).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses server A, authenticated owner, and returns inherited reply with its own display version', async () => {
    mocks.limits.mockResolvedValue({ maxTurns: 90, retainTurns: 37 });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${SOURCE}/branch`,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.fork).toHaveBeenCalledExactlyOnceWith({
        userId: USER,
        sourceSessionId: SOURCE,
        messageId: MESSAGE,
        requestId: REQUEST,
        retainTurns: 37,
      });
      expect(mocks.list).toHaveBeenCalledExactlyOnceWith(BRANCH, '开场白');
      expect(response.json()).toMatchObject({
        success: true,
        data: {
          session: {
            id: BRANCH,
            branch: {
              source_session_id: SOURCE,
              source_turn_index: 20,
              inherited_turns: 20,
            },
          },
          messages: [
            {
              id: MESSAGE,
              session_id: BRANCH,
              inherited: true,
              postprocess_version: 4,
              content: inherited.content,
            },
          ],
          has_more: false,
        },
      });
      expect(response.json().data.session).not.toHaveProperty('user_id');
    } finally {
      await app.close();
    }
  });

  it.each([
    ['session_not_found', 404],
    ['branch_not_allowed', 409],
    ['branch_request_conflict', 409],
    ['branch_rate_limited', 429],
  ] as const)('returns %s without leaking database details', async (code, status) => {
    mocks.fork.mockRejectedValue(new ConversationRepositoryError(code, 'private database detail'));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${SOURCE}/branch`,
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain('private database detail');
      expect(mocks.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('keeps the same idempotency key when a committed branch page read fails and the caller retries', async () => {
    mocks.list
      .mockRejectedValueOnce(new Error('page read failed'))
      .mockResolvedValue({ messages: [inherited], hasMore: true });
    const app = await buildApp();
    try {
      const request = {
        method: 'POST' as const,
        url: `/api/v1/conversations/${SOURCE}/branch`,
        payload,
      };
      const failed = await app.inject(request);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain('page read failed');
      const retried = await app.inject(request);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().data).toMatchObject({
        session: { id: BRANCH },
        has_more: true,
      });
      expect(mocks.fork.mock.calls).toHaveLength(2);
      expect(mocks.fork.mock.calls[0]).toEqual(mocks.fork.mock.calls[1]);
    } finally {
      await app.close();
    }
  });
});
