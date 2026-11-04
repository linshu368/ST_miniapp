import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCharacterDraft } from '@miniapp/shared';

const mocks = vi.hoisted(() => ({
  canUse: vi.fn(),
  character: vi.fn(),
  characters: vi.fn(),
  ownedDraft: vi.fn(),
  author: vi.fn(),
  featured: vi.fn(),
  snapshot: vi.fn(),
  user: vi.fn(),
  cover: vi.fn(),
  publicHead: vi.fn(),
}));
vi.mock('../lib/db.js', () => ({
  prisma: {
    character: { findFirst: mocks.character, findMany: mocks.characters },
    characterCreation: { findFirst: mocks.ownedDraft },
    $queryRaw: mocks.author,
  },
}));
vi.mock('../features/creator/access.js', () => ({
  canUseCharacter: mocks.canUse,
  discoverableCharacterWhere: { enabled: true, archived_at: null },
}));
vi.mock('../features/creator/covers.js', () => ({
  resolveCreatorCoverUrl: mocks.cover,
  resolvePublicCreatorCoverUrls: async () => new Map(),
}));
vi.mock('../features/lobby/pinned-characters.js', () => ({
  resolveLobbyPinnedCharacters: async () => ({ characterIds: [] }),
}));
vi.mock('../features/lobby/recommendation.js', () => ({
  getPublicLobbyHeadOrder: mocks.publicHead,
}));
vi.mock('../lib/supabase.js', () => ({
  getDomainDb: () => ({ rpc: mocks.snapshot }),
}));
vi.mock('../features/lobby/featured-snapshot.js', () => ({
  loadLobbyFeaturedIdSet: mocks.featured,
}));
vi.mock('../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {},
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../middleware/auth.js', () => ({
  optionalTelegramAuth: vi.fn(async () => {}),
  requireTelegramAuth: vi.fn(async () => {}),
}));
vi.mock('../platform/config.js', () => ({
  config: { supabase: { url: 'https://storage.example.invalid' } },
}));
import characterRoutes from './characters.js';

const cardId = '70000000-0000-4000-8000-000000000011';
const viewerId = '70000000-0000-4000-8000-000000000012';
const sessionId = '70000000-0000-4000-8000-000000000013';
const character = {
  id: cardId,
  name: '当前角色',
  description: '当前简介',
  avatar_url: 'https://example.invalid/current.png',
  tags: ['日常'],
  creator: '原始作者',
  first_mes: '当前开场',
  creator_notes: '备注',
};
const frozen = {
  name: '开聊时的角色',
  description: '开聊时的简介',
  avatar_url: 'https://example.invalid/frozen.png',
  tags: ['旧标签'],
  creator: '旧署名',
  first_mes: '开聊时的开场',
  creator_notes: '旧备注',
};
let app: FastifyInstance;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.canUse.mockResolvedValue(true);
  mocks.character.mockResolvedValue(character);
  mocks.characters.mockResolvedValue([character]);
  mocks.ownedDraft.mockResolvedValue(null);
  mocks.author.mockResolvedValue([]);
  mocks.featured.mockResolvedValue(new Set());
  mocks.snapshot.mockReturnValue({
    abortSignal: () => Promise.resolve({ data: null, error: null }),
  });
  mocks.user.mockResolvedValue({ id: viewerId });
  mocks.cover.mockResolvedValue('https://example.invalid/owner-cover.png');
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-anonymous'] !== '1')
      request.user = { id: 1, first_name: 'Fixture' };
  });
  await app.register(characterRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('character detail creator credit', () => {
  it.each([
    [
      { display_name: '  平台昵称  ', tg_first_name: 'Telegram名字', tg_username: 'username' },
      '平台昵称',
    ],
    [
      { display_name: ' ', tg_first_name: '  Telegram名字  ', tg_username: 'username' },
      'Telegram名字',
    ],
    [{ display_name: null, tg_first_name: ' ', tg_username: '  username  ' }, '匿名作者'],
    [{ display_name: '你', tg_first_name: null, tg_username: null }, '你'],
  ])('uses the creator public display-name precedence %j', async (profile, expected) => {
    mocks.author.mockResolvedValue([profile]);
    const response = await app.inject('/api/characters/' + cardId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character.author_name).toBe(expected);
    expect(response.json().data.character).not.toHaveProperty('owner_user_id');
    expect(response.json().data.character).not.toHaveProperty('tg_username');
    expect(mocks.author).toHaveBeenCalledTimes(1);
  });

  it('opens the public space of an existing creator card even if its stored author is blank', async () => {
    mocks.character.mockResolvedValue({ ...character, creator: '' });
    mocks.author.mockResolvedValue([
      { display_name: '已公开的作者', tg_first_name: null, public_creator_id: cardId },
    ]);
    const result = await app.inject('/api/characters/' + cardId);
    expect(result.json().data.character).toMatchObject({
      author_name: '已公开的作者',
      public_creator_id: cardId,
    });
    expect(result.json().data.character).not.toHaveProperty('owner_user_id');
  });

  it('preserves the original credit when no creator ownership row exists', async () => {
    const response = await app.inject('/api/characters/' + cardId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character.author_name).toBe('原始作者');
  });

  it.each([
    { display_name: null, tg_first_name: null, tg_username: null },
    { display_name: ' ', tg_first_name: ' ', tg_username: '' },
  ])('uses a neutral anonymous author for missing or empty UGC profile %j', async (profile) => {
    mocks.author.mockResolvedValue([profile]);
    const response = await app.inject('/api/characters/' + cardId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character.author_name).toBe('匿名作者');
  });

  it('keeps the detail usable with its existing credit when author lookup fails', async () => {
    mocks.author.mockRejectedValue(new Error('fixture lookup unavailable'));
    const response = await app.inject('/api/characters/' + cardId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character.author_name).toBe('原始作者');
    expect(response.json().data.character.greeting).toBe('当前开场');
  });

  it('does not look up creator profiles when character access is denied', async () => {
    mocks.canUse.mockResolvedValue(false);
    const response = await app.inject('/api/characters/' + cardId);
    expect(response.statusCode).toBe(404);
    expect(mocks.author).not.toHaveBeenCalled();
    expect(mocks.character).not.toHaveBeenCalled();
    expect(mocks.ownedDraft).not.toHaveBeenCalled();
  });

  it('keeps current creator credit separate from the frozen session presentation', async () => {
    mocks.snapshot.mockReturnValue({
      abortSignal: () => Promise.resolve({ data: frozen, error: null }),
    });
    mocks.author.mockResolvedValue([
      { display_name: '最新作者昵称', tg_first_name: null, tg_username: null },
    ]);
    const response = await app.inject('/api/characters/' + cardId + '?session_id=' + sessionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character).toEqual({
      id: cardId,
      name: frozen.name,
      description: frozen.description,
      avatar_url: frozen.avatar_url,
      personality_tags: frozen.tags,
      author_name: '最新作者昵称',
      is_featured: false,
      greeting: frozen.first_mes,
      creator_notes: frozen.creator_notes,
    });
    expect(mocks.snapshot).toHaveBeenCalledWith('read_session_character_version', {
      p_character_id: cardId,
      p_user_id: viewerId,
      p_session_id: sessionId,
      p_presentation: true,
    });
    expect(mocks.character).not.toHaveBeenCalled();
    expect(mocks.ownedDraft).not.toHaveBeenCalled();
  });

  it('retains frozen official credit when the optional live author lookup fails', async () => {
    mocks.snapshot.mockReturnValue({
      abortSignal: () => Promise.resolve({ data: frozen, error: null }),
    });
    mocks.author.mockRejectedValue(new Error('fixture lookup unavailable'));
    const response = await app.inject('/api/characters/' + cardId + '?session_id=' + sessionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character.author_name).toBe('旧署名');
    expect(response.json().data.character.name).toBe(frozen.name);
  });

  it("does not read author details for another viewer's inaccessible session", async () => {
    mocks.snapshot.mockReturnValue({
      abortSignal: () => Promise.resolve({ data: null, error: { code: 'P0404' } }),
    });
    const response = await app.inject('/api/characters/' + cardId + '?session_id=' + sessionId);
    expect(response.statusCode).toBe(404);
    expect(mocks.author).not.toHaveBeenCalled();
  });

  it('keeps the owner draft view and its public author name independent', async () => {
    mocks.ownedDraft.mockResolvedValue({
      draft: { ...emptyCharacterDraft(), name: '作者正在修改的新名', opening: '草稿开场' },
      cover_asset_id: null,
    });
    mocks.author.mockResolvedValue([
      { display_name: '作者昵称', tg_first_name: null, tg_username: null },
    ]);
    const response = await app.inject('/api/characters/' + cardId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.character.name).toBe('作者正在修改的新名');
    expect(response.json().data.character.greeting).toBe('草稿开场');
    expect(response.json().data.character.author_name).toBe('作者昵称');
  });

  it('does not add author profile queries to the lobby list', async () => {
    const response = await app.inject('/api/characters?sort=latest');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.characters).toHaveLength(1);
    expect(mocks.author).not.toHaveBeenCalled();
    expect(mocks.ownedDraft).not.toHaveBeenCalled();
  });
});

describe('public bounded recommendation fallback', () => {
  it('revalidates the supplied public IDs in their original order without drawing a new head', async () => {
    mocks.author.mockResolvedValue([character]);
    const response = await app.inject({
      url: `/api/characters?sort=recommended&limit=12&ids=${viewerId},${cardId}`,
      headers: { 'x-test-anonymous': '1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.characters.map((row: { id: string }) => row.id)).toEqual([cardId]);
    expect(mocks.author.mock.calls[0]?.slice(1)).toEqual([JSON.stringify([viewerId, cardId]), 12]);
    expect(mocks.publicHead).not.toHaveBeenCalled();
    expect(mocks.characters).not.toHaveBeenCalled();
  });

  it.each([
    'sort=recommended&limit=12&ids=',
    'sort=recommended&limit=12&ids=not-a-uuid',
    `sort=recommended&limit=12&ids=${cardId},${cardId}`,
    `sort=recommended&limit=12&ids=${Array.from({ length: 13 }, (_, i) => '70000000-0000-4000-8000-' + String(i).padStart(12, '0')).join(',')}`,
    `sort=recommended&limit=12&ids=${cardId}&ids=${viewerId}`,
    `sort=latest&limit=12&ids=${cardId}`,
    `sort=recommended&limit=13&ids=${cardId}`,
  ])(
    'rejects malformed or unbounded public head query %s before reading any directory',
    async (query) => {
      expect((await app.inject('/api/characters?' + query)).statusCode).toBe(400);
      expect(mocks.author).not.toHaveBeenCalled();
      expect(mocks.publicHead).not.toHaveBeenCalled();
      expect(mocks.characters).not.toHaveBeenCalled();
    }
  );

  it('excludes test cards on full recommended tail/search while preserving the latest directory', async () => {
    expect((await app.inject('/api/characters?sort=recommended')).statusCode).toBe(200);
    expect(mocks.characters.mock.calls.at(-1)?.[0].where.is_test).toBe(false);
    expect((await app.inject('/api/characters?sort=latest')).statusCode).toBe(200);
    expect(mocks.characters.mock.calls.at(-1)?.[0].where).not.toHaveProperty('is_test');
  });
  it('uses the head-only path for an unauthenticated caller without loading the full directory', async () => {
    mocks.publicHead.mockResolvedValue([cardId]);
    mocks.author.mockResolvedValue([character]);
    const response = await app.inject({
      url: '/api/characters?sort=recommended&limit=12',
      headers: { 'x-test-anonymous': '1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.characters).toEqual([
      expect.objectContaining({ id: cardId, avatar_url: character.avatar_url }),
    ]);
    expect(mocks.characters).not.toHaveBeenCalled();
    expect(mocks.publicHead).toHaveBeenCalledOnce();
  });
});
