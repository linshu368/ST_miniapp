import Fastify, { type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeedbackError } from '../features/chat-feedback/repository.js';
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), user: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    if (request.headers['x-test-auth'] !== 'missing')
      request.user = { id: 123, first_name: 'Synthetic' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/chat-feedback/repository.js', async (original) => ({
  ...(await original<typeof import('../features/chat-feedback/repository.js')>()),
  ChatFeedbackRepository: class {
    get = mocks.get;
    save = mocks.save;
  },
}));
import routes from './chat-feedback.js';
const id = '10000000-0000-4000-8000-000000000001';
const url = `/api/v1/conversations/${id}/messages/${id}/feedback`;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: 'verified-owner' });
  mocks.save.mockResolvedValue({ feedback: { id } });
  mocks.get.mockResolvedValue({ feedback: null });
});
async function request(method: 'GET' | 'PUT', suffix = '', payload?: object, authenticated = true) {
  const app = Fastify();
  await app.register(routes);
  try {
    return await app.inject({
      method,
      url: url + suffix,
      payload,
      headers: authenticated ? {} : { 'x-test-auth': 'missing' },
    });
  } finally {
    await app.close();
  }
}
describe('reply feedback route', () => {
  it('binds identity from authentication and accepts empty feedback', async () => {
    const response = await request('PUT', '', { expected_version: 0 });
    expect(response.statusCode).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith('verified-owner', id, id, {
      expected_version: 0,
      reasons: [],
      detail: '',
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('reads only authenticated owner and requested edit version', async () => {
    expect((await request('GET', '?edit_version=2')).statusCode).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith('verified-owner', id, id, 2);
  });
  it('rejects missing authentication', async () => {
    expect((await request('PUT', '', { expected_version: 0 }, false)).statusCode).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    { expected_version: 0, user_id: id },
    { expected_version: 0, reasons: ['invented'] },
    { expected_version: -1 },
    { expected_version: 0, detail: 'x'.repeat(501) },
  ])('rejects invalid fields before DB work', async (body) => {
    expect((await request('PUT', '', body)).statusCode).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    ['P0002', 404],
    ['P0426', 409],
    ['P0429', 429],
    ['08006', 503],
  ] as const)('handles %s without leaking backend text', async (code, status) => {
    mocks.save.mockRejectedValueOnce(new ChatFeedbackError(code));
    const response = await request('PUT', '', { expected_version: 0 });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain('database operation');
  });
});
