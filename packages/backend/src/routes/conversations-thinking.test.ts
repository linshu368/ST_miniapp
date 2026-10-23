import Fastify, { type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = '11111111-2222-4333-8444-555555555555';
const routing = vi.hoisted(() => ({
  requireSession: vi.fn(),
  runTurn: vi.fn(),
  user: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    request.user = { id: 12345, first_name: 'Test' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: routing.user }));
vi.mock('../platform/model-tiers.js', () => ({
  fetchModelCatalogSnapshot: async () => ({
    catalog: { first_token_deadline_ms: 6000 },
    version: 1,
  }),
}));
vi.mock('../infrastructure/repositories/ChatSessionRepository.js', () => ({
  ChatSessionRepository: class {
    requireSession = routing.requireSession;
  },
  toChatSession: (row: unknown) => row,
}));
vi.mock('../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {},
  toChatMessages: () => [],
}));
vi.mock('../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {},
}));
vi.mock('../features/conversations/index.js', () => ({
  applyUserPlaceholderToMessages: (value: unknown) => value,
  applyUserPlaceholderToSession: (value: unknown) => value,
  createReplyStreamSink: () => ({
    opened: false,
    clientGone: false,
    open() {},
    send() {},
    close() {},
  }),
  runConversationTurn: routing.runTurn,
  withConversationPreparationDeadline: (work: Promise<unknown>) => work,
  sendConversationError: () => false,
}));

beforeEach(() => {
  Object.values(routing).forEach((mock) => mock.mockReset());
  routing.user.mockResolvedValue({ id: 'test-user' });
  routing.requireSession.mockResolvedValue({ id: SESSION, user_id: 'test-user' });
  // A pre-stream outcome avoids any real LLM, DB or wallet work in this route contract test.
  routing.runTurn.mockResolvedValue({ kind: 'upstream_error', upstreamStatus: 503 });
});

async function buildApp() {
  const { default: conversationRoutes } = await import('./conversations.js');
  const app = Fastify({ logger: false });
  await app.register(conversationRoutes);
  await app.ready();
  return app;
}

describe('thinking request validation before accepting a conversation turn', () => {
  it.each(['messages', 'regenerate'] as const)(
    '%s accepts omitted/true/false with legacy default off',
    async (path) => {
      const app = await buildApp();
      try {
        for (const value of [undefined, true, false]) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${SESSION}/${path}`,
            payload: {
              ...(path === 'messages' ? { content: 'hello' } : {}),
              ...(value === undefined ? {} : { thinking_enabled: value }),
            },
          });
          expect(response.statusCode).toBe(502);
          expect(routing.runTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
              thinkingEnabled: value ?? false,
              mode:
                path === 'messages' ? { kind: 'send', content: 'hello' } : { kind: 'regenerate' },
            })
          );
        }
      } finally {
        await app.close();
      }
    }
  );

  it.each(['messages', 'regenerate'] as const)(
    '%s rejects all non-boolean values before DB/precheck work',
    async (path) => {
      const app = await buildApp();
      try {
        for (const value of [null, 0, 1, 'false', 'true', [], {}]) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/conversations/${SESSION}/${path}`,
            payload: {
              ...(path === 'messages' ? { content: 'hello' } : {}),
              thinking_enabled: value,
            },
          });
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
        }
        expect(routing.user).not.toHaveBeenCalled();
        expect(routing.requireSession).not.toHaveBeenCalled();
        expect(routing.runTurn).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
});
