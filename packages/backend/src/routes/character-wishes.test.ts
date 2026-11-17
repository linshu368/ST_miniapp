import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  setSupported: vi.fn(),
  withdraw: vi.fn(),
  linkResponse: vi.fn(),
  user: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({ requireTelegramAuth: vi.fn(async () => {}) }));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/character-wishes/repository.js', () => ({
  CharacterWishRepository: class {
    list = mocks.list;
    get = mocks.get;
    create = mocks.create;
    setSupported = mocks.setSupported;
    withdraw = mocks.withdraw;
    linkResponse = mocks.linkResponse;
  },
}));
import routes from './character-wishes.js';

const userId = '77000000-0000-4000-8000-000000000001';
const wishId = '77000000-0000-4000-8000-000000000011';
const cardId = '77000000-0000-4000-8000-000000000021';
let app: FastifyInstance;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: userId });
  for (const method of [
    'list',
    'get',
    'create',
    'setSupported',
    'withdraw',
    'linkResponse',
  ] as const)
    mocks[method].mockResolvedValue({ fixture: true });
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (!request.headers['x-anonymous']) request.user = { id: 1, first_name: 'Fixture' };
  });
  await app.register(routes);
});
afterEach(() => app.close());

it('requires authentication before any wish read', async () => {
  const r = await app.inject({ url: '/api/character-wishes', headers: { 'x-anonymous': '1' } });
  expect(r.statusCode).toBe(401);
  expect(mocks.list).not.toHaveBeenCalled();
});
it.each(['scope=private', 'owner_user_id=' + userId, 'page=0', 'page_size=500', 'sort=raw'])(
  'rejects invalid/forged query %s',
  async (query) => {
    const r = await app.inject('/api/character-wishes?' + query);
    expect(r.statusCode).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  }
);
it('uses server identity for mine listing and private cache headers', async () => {
  const r = await app.inject('/api/character-wishes?scope=mine&page=2');
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(mocks.list).toHaveBeenCalledWith(userId, {
    scope: 'mine',
    sort: 'newest',
    page: 2,
    page_size: 12,
  });
});
it('trims body and accepts an idempotent client UUID', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/character-wishes',
    payload: { id: wishId, body: ' 想玩一个旅店老板 ', visibility: 'public' },
  });
  expect(r.statusCode).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith(userId, {
    id: wishId,
    body: '想玩一个旅店老板',
    visibility: 'public',
  });
});
it.each([
  { body: '' },
  { body: 'x'.repeat(501) },
  { owner_user_id: cardId },
  { visibility: 'private' },
  { visibility: 'unknown' },
])('rejects invalid creation %j', async (extra) => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/character-wishes',
    payload: { id: wishId, body: '想玩一个旅店老板', visibility: 'public', ...extra },
  });
  expect(r.statusCode).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});
it('sends explicit support state and owner withdrawal identity', async () => {
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/character-wishes/${wishId}/support`,
        payload: { supported: false },
      })
    ).statusCode
  ).toBe(200);
  expect(mocks.setSupported).toHaveBeenCalledWith(userId, wishId, false);
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/character-wishes/${wishId}` })).statusCode
  ).toBe(200);
  expect(mocks.withdraw).toHaveBeenCalledWith(userId, wishId);
});
it('validates response character and supplies server ownership', async () => {
  const r = await app.inject({
    method: 'POST',
    url: `/api/character-wishes/${wishId}/responses`,
    payload: { character_id: cardId },
  });
  expect(r.statusCode).toBe(200);
  expect(mocks.linkResponse).toHaveBeenCalledWith({ userId, wishId, characterId: cardId });
});
it.each(['P0404', '42501', 'P0409', '08006'])('sanitizes database errors %s', async (code) => {
  mocks.get.mockRejectedValue(
    Object.assign(new Error('private submitted text'), { code, detail: 'private content' })
  );
  const r = await app.inject(`/api/character-wishes/${wishId}`);
  expect(r.statusCode).toBe(
    ({ P0404: 404, '42501': 403, P0409: 409, '08006': 503 } as Record<string, number>)[code]
  );
  expect(r.body).not.toContain('private');
});
