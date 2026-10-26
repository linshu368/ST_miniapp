import Fastify, { type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = '11111111-2222-4333-8444-555555555555';
const routing = vi.hoisted(() => ({
  requireSession: vi.fn(),
  runTurn: vi.fn(),
  user: vi.fn(),
  getGenerationConfig: vi.fn(),
  getOrCreate: vi.fn(),
  patch: vi.fn(),
  runtime: vi.fn(),
  cancel: vi.fn(),
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
  ConversationHistoryRepository: class {
    cancelTurn = routing.cancel;
  },
  toChatMessages: () => [],
}));
vi.mock('../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {
    getGenerationConfig = routing.getGenerationConfig;
    getOrCreate = routing.getOrCreate;
    patch = routing.patch;
  },
  toUserSettings: (row: unknown) => row,
}));
vi.mock('../platform/runtime-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/runtime-config.js')>()),
  fetchRuntimeConfigEntry: routing.runtime,
}));
vi.mock('../features/engine/platform-instructions.js', () => ({
  fetchPlatformInstructions: async () => ({ instructions: { wordCountTiers: {} } }),
  toPublicWordCountTiersFromEngine: () => ({
    tiers: [{ id: '300-500', ui_label: '适中', sort_order: 0 }],
    default_tier_id: '300-500',
    layout: { columns: 4 },
  }),
}));
vi.mock('../features/conversations/index.js', () => ({
  CONVERSATION_PREPARATION_TIMEOUT_MS: 20_000,
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
  routing.cancel.mockResolvedValue({ id: SESSION, status: 'stream_interrupted' });
  // A pre-stream outcome avoids any real LLM, DB or wallet work in this route contract test.
  routing.runTurn.mockResolvedValue({ kind: 'upstream_error', upstreamStatus: 503 });
  routing.getGenerationConfig.mockResolvedValue({
    selected_model_id: null,
    pref_word_count: '300-500',
    pref_show_options: true,
    pref_show_status: true,
    pref_show_memory: true,
    pref_reply_styles: {},
    pref_custom_instructions: 'existing custom preference',
  });
  routing.getOrCreate.mockImplementation(() => routing.getGenerationConfig());
  routing.patch.mockImplementation(
    async (_id: string, _user: unknown, patch: { pref_reply_styles?: Record<string, boolean> }) => {
      const current = await routing.getGenerationConfig();
      const next = {
        ...current,
        pref_reply_styles: { ...current.pref_reply_styles, ...patch.pref_reply_styles },
      };
      routing.getGenerationConfig.mockResolvedValue(next);
      return next;
    }
  );
  routing.runtime.mockResolvedValue({
    value: {
      options: [
        {
          id: 'style-visible',
          name: '表达方式',
          description: '说明',
          marker: 'PRIVATE_MARKER',
          rules: 'PRIVATE_RULE',
          enabled: true,
        },
        {
          id: 'style-hidden',
          name: '隐藏项',
          description: '',
          marker: '',
          rules: '',
          enabled: false,
        },
      ],
    },
    version: 1,
    textValue: null,
  });
});

describe('explicit cancel intent validation', () => {
  it.each([undefined, 'user_stop', 'first_token_timeout'] as const)(
    'passes the compatible %s intent only after ownership validation',
    async (reason) => {
      const app = await buildApp();
      try {
        const result = await app.inject({
          method: 'POST',
          url: `/api/v1/conversations/${SESSION}/cancel`,
          payload: { assistant_message_id: SESSION, ...(reason ? { reason } : {}) },
        });
        expect(result.statusCode).toBe(200);
        expect(routing.cancel).toHaveBeenCalledExactlyOnceWith(SESSION, SESSION, reason);
        expect(routing.requireSession.mock.invocationCallOrder[0]).toBeLessThan(
          routing.cancel.mock.invocationCallOrder[0]!
        );
      } finally {
        await app.close();
      }
    }
  );
  it.each([null, 1, 'timeout', 'user_cancelled', {}, []])(
    'rejects invalid reason %j before database work',
    async (reason) => {
      const app = await buildApp();
      try {
        const result = await app.inject({
          method: 'POST',
          url: `/api/v1/conversations/${SESSION}/cancel`,
          payload: { assistant_message_id: SESSION, reason },
        });
        expect(result.statusCode).toBe(400);
        expect(routing.user).not.toHaveBeenCalled();
        expect(routing.cancel).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
});

async function buildApp() {
  const { default: conversationRoutes } = await import('./conversations.js');
  const { default: settingsRoutes } = await import('./settings.js');
  const app = Fastify({ logger: false });
  await app.register(conversationRoutes);
  await app.register(settingsRoutes);
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

describe('generic reply-style UI settings routes', () => {
  it('GET/PATCH share ordered public metadata, hide private fields, and persist independent choices', async () => {
    const app = await buildApp();
    try {
      const initial = await app.inject({ method: 'GET', url: '/api/v1/generation-config' });
      const metadata = [{ id: 'style-visible', name: '表达方式', description: '说明' }];
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        data: { config: { pref_reply_styles: {} }, reply_style_options: metadata },
      });
      expect(initial.body).not.toContain('PRIVATE_');
      expect(initial.body).not.toContain('style-hidden');

      for (const id of ['style-visible', 'style-retired']) {
        const response = await app.inject({
          method: 'PATCH',
          url: '/api/v1/generation-config',
          payload: { pref_reply_styles: { [id]: true } },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.reply_style_options).toEqual(metadata);
        expect(response.body).not.toContain('PRIVATE_');
        expect(routing.patch).toHaveBeenLastCalledWith('test-user', expect.anything(), {
          pref_reply_styles: { [id]: true },
        });
      }
      const result = await app.inject({ method: 'GET', url: '/api/users/settings' });
      expect(result.json()).toMatchObject({
        data: {
          settings: {
            pref_reply_styles: { 'style-visible': true, 'style-retired': true },
            pref_custom_instructions: 'existing custom preference',
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it.each(['/api/v1/generation-config', '/api/users/settings'])(
    '%s rejects invalid map/boolean/id inputs before writing',
    async (url) => {
      const app = await buildApp();
      try {
        for (const value of [null, true, [], { 'style-first': 'true' }, { wrong: true }]) {
          const response = await app.inject({
            method: 'PATCH',
            url,
            payload: { pref_reply_styles: value },
          });
          expect(response.statusCode).toBe(400);
        }
        expect(routing.patch).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it('the alternate settings API accepts true and false and preserves other IDs', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/users/settings',
        payload: { pref_reply_styles: { 'style-first': true, 'style-second': false } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          settings: {
            pref_reply_styles: { 'style-first': true, 'style-second': false },
          },
        },
      });
      expect(response.body).not.toContain('PRIVATE_');
    } finally {
      await app.close();
    }
  });
});
