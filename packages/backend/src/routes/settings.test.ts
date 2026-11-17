import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions } from '../lib/logger-options.js';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), download: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    request.user = { id: 12345, first_name: 'Test' };
  },
}));
vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: async () => ({ id: '10000000-0000-4000-8000-000000000001' }),
}));
vi.mock('./user-onboarding.js', () => ({ registerUserOnboardingRoute() {} }));
vi.mock('../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {
    patch = mocks.patch;
  },
  toUserSettings: (row: unknown) => row,
}));
vi.mock('../lib/user-avatar.js', () => ({
  downloadRemoteAvatar: mocks.download,
  decodeUploadedAvatar: vi.fn(),
  deleteStoredUserAvatar: vi.fn(),
  storeUserAvatar: vi.fn(),
}));

describe('settings failure logging', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    {
      method: 'PATCH' as const,
      url: '/api/users/settings',
      payload: {},
      mock: mocks.patch,
      event: 'user.settings.update_failed',
    },
    {
      method: 'POST' as const,
      url: '/api/users/avatar',
      payload: { source: 'url', url: 'https://example.invalid/private' },
      mock: mocks.download,
      event: 'user.avatar.import_failed',
    },
  ])(
    'preserves the response and safely records $event',
    async ({ method, url, payload, mock, event }) => {
      const original = Object.assign(new Error('fixture storage failure'), { code: 'ECONNRESET' });
      mock.mockRejectedValueOnce(original);
      const lines: string[] = [];
      const app = Fastify({
        logger: {
          ...fastifyLoggerOptions(),
          level: 'error',
          transport: undefined,
          stream: {
            write: (line: string) => {
              lines.push(line);
            },
          },
        },
      });
      const { default: routes } = await import('./settings.js');
      await app.register(routes);
      try {
        const response = await app.inject({ method, url, payload });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toEqual({ code: 'BAD_REQUEST', message: original.message });
        expect(lines.map((line) => JSON.parse(line))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event,
              level: 50,
              err: expect.objectContaining({ type: 'Error', code: original.code }),
            }),
          ])
        );
        expect(lines.join('')).not.toContain(original.message);
        expect(lines.join('')).not.toContain('example.invalid');
      } finally {
        await app.close();
      }
    }
  );
});
