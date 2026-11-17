import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { publicAuthorName } from '../features/creator/public-author.js';
import publicCreatorRoutes from './public-creators.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), cover: vi.fn() }));
vi.mock('../lib/db.js', () => ({ prisma: { $transaction: mocks.read } }));
vi.mock('./characters.js', () => ({ resolvePublicCharacterAvatarUrls: mocks.cover }));
const id = '00000000-0000-0000-0000-000000000001';
const url = '/api/creators/' + id + '/characters';
let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(publicCreatorRoutes);
});
beforeEach(() => {
  vi.resetAllMocks();
});
afterAll(() => app.close());

it('publishes only card summaries and page state, without exposing user identifiers or probe rows', async () => {
  const cards = Array.from({ length: 12 }, (_, i) => ({
    id: 'card-' + i,
    name: '发布版' + i,
    tags: ['日常'],
    description: '简介',
    avatar_url: 'cover-asset-' + i,
    like_count: i + 3,
    favorite_count: i,
    draft: { name: '未公开' },
    owner_user_id: 'internal-owner',
  }));
  mocks.read.mockResolvedValue([
    { display_name: ' 喜欢写故事 ', tg_first_name: '另一名称', has_more: true, cards },
  ]);
  mocks.cover.mockResolvedValue(
    new Map(cards.map((card) => [card.id, 'https://media.example/cover']))
  );
  const r = await app.inject(url);
  expect(r.statusCode).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.json().data).toMatchObject({ author_name: '喜欢写故事', page: 1, has_more: true });
  expect(r.json().data.characters).toHaveLength(12);
  expect(r.body).not.toMatch(/cover-asset|owner_user_id|internal-owner|未公开|另一名称|card-12/);
  expect(r.json().data.characters[0]).toMatchObject({ like_count: 3, favorite_count: 0 });
  expect(r.json().data.characters[11]).toMatchObject({ like_count: 14, favorite_count: 11 });
  expect(mocks.cover).toHaveBeenCalledTimes(1);
});

it('uses the nickname, then first name, then an anonymous label', () => {
  expect(publicAuthorName({ display_name: ' ', tg_first_name: ' 小鱼 ' })).toBe('小鱼');
  expect(publicAuthorName({ display_name: null, tg_first_name: null })).toBe('匿名作者');
  expect(publicAuthorName(null)).toBe('匿名作者');
});

it('returns an empty last page for an existing public author and 404 for an unavailable space', async () => {
  mocks.read
    .mockResolvedValueOnce([
      { display_name: null, tg_first_name: null, cards: [], has_more: false },
    ])
    .mockResolvedValueOnce([]);
  const r = await app.inject(url + '?page=3');
  expect(r.json().data).toEqual({
    author_name: '匿名作者',
    characters: [],
    page: 3,
    has_more: false,
  });
  expect((await app.inject(url)).statusCode).toBe(404);
});

it('rejects invalid ids and attempts to substitute a different owner or page size', async () => {
  for (const invalid of [
    url.replace(id, 'bad'),
    url + '?page=0',
    url + '?owner_user_id=' + id,
    url + '?page_size=200',
  ]) {
    expect((await app.inject(invalid)).statusCode).toBe(400);
  }
  expect(mocks.read).not.toHaveBeenCalled();
});
