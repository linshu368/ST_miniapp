import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CreatorAnalyticsQuerySchema } from '@miniapp/shared';
import { analyticsWindow } from '../features/creator/analytics-query.js';
const mocks = vi.hoisted(() => ({ read: vi.fn(), user: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireTelegramAuth: vi.fn(async () => {}) }));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/creator/analytics-repository.js', () => ({ getCreatorAnalytics: mocks.read }));
import routes from './creator-analytics.js';
let app: FastifyInstance;
const owner = '75000000-0000-4000-8000-000000000001';
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: owner });
  mocks.read.mockResolvedValue({ section: 'overview' });
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (!request.headers['x-anonymous']) request.user = { id: 1, first_name: 'Fixture' };
  });
  await app.register(routes);
});
afterEach(async () => {
  await app.close();
});
it('requires authentication before invoking analytics', async () => {
  const r = await app.inject({ url: '/api/creator/analytics', headers: { 'x-anonymous': '1' } });
  expect(r.statusCode).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled();
});
it.each([
  'owner_user_id=' + owner,
  'character_id=bad',
  'page=0',
  'page_size=500',
  'period=1d',
  'section=raw',
  'as_of=bad',
])('rejects forged or malformed query %s', async (query) => {
  const r = await app.inject('/api/creator/analytics?' + query);
  expect(r.statusCode).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('uses the server identity and private cache headers', async () => {
  const r = await app.inject('/api/creator/analytics?section=rewards&page=2&page_size=4');
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('private, no-store');
  expect(mocks.read).toHaveBeenCalledWith(
    owner,
    expect.objectContaining({ section: 'rewards', page: 2, page_size: 4 })
  );
});
it('does not expose a foreign or missing card', async () => {
  mocks.read.mockRejectedValue(Object.assign(new Error('private id'), { code: 'NOT_FOUND' }));
  const r = await app.inject('/api/creator/analytics');
  expect(r.statusCode).toBe(404);
  expect(r.body).not.toContain('private id');
});
it('read failures never turn into zero success or leak details', async () => {
  mocks.read.mockRejectedValue(new Error('private database detail'));
  const r = await app.inject('/api/creator/analytics');
  expect(r.statusCode).toBe(503);
  expect(r.body).not.toContain('private database detail');
});
it('uses Beijing calendar days and clamps future snapshots', () => {
  const now = new Date('2026-11-02T17:00:00Z');
  const w = analyticsWindow(CreatorAnalyticsQuerySchema.parse({ period: '7d' }), now);
  expect(w.today.toISOString()).toBe('2026-11-02T16:00:00.000Z');
  expect(w.start?.toISOString()).toBe('2026-10-27T16:00:00.000Z');
  expect(
    analyticsWindow(CreatorAnalyticsQuerySchema.parse({ as_of: '2099-01-01T00:00:00Z' }), now).end
  ).toEqual(now);
});
