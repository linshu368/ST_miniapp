import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const userId = '20000000-0000-4000-8000-000000000001';
const batchId = '30000000-0000-4000-8000-000000000001';
const cardId = '10000000-0000-4000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  denied: false,
  get: vi.fn(),
  exposures: vi.fn(),
  headCards: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (mocks.denied) return reply.code(401).send({ error: 'unauthorized' });
    request.user = { id: 123, first_name: 'fixture' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: async () => ({ id: userId }) }));
vi.mock('../features/lobby/recommendation.js', () => ({
  getLobbyRecommendation: mocks.get,
  reportLobbyRecommendationExposures: mocks.exposures,
}));
vi.mock('./characters.js', () => ({ loadLobbyHeadCards: mocks.headCards }));
import routes from './lobby-recommendation.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.denied = false;
  mocks.get.mockResolvedValue({
    enabled: false,
    degraded: false,
    batch_id: null,
    generated_at: null,
    expires_at: null,
    character_ids: [],
    head_ids: [],
    previous_batch_id: null,
  });
  mocks.exposures.mockResolvedValue(1);
});
async function post(suffix: string, payload: object) {
  const app = Fastify();
  await app.register(routes);
  try {
    return await app.inject({
      method: 'POST',
      url: '/api/characters/recommendation' + suffix,
      payload,
    });
  } finally {
    await app.close();
  }
}

describe('authenticated recommendation ordering', () => {
  it('requires authentication before either personalized operation', async () => {
    mocks.denied = true;
    expect((await post('', { action: 'open', request_id: batchId })).statusCode).toBe(401);
    expect(
      (await post('/exposures', { batch_id: batchId, character_ids: [cardId] })).statusCode
    ).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.exposures).not.toHaveBeenCalled();
  });
  it('uses server identity and private no-store, preserves CAS and retry IDs', async () => {
    const body = { action: 'refresh', request_id: batchId, expected_batch_id: cardId };
    const response = await post('', body);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(mocks.get).toHaveBeenCalledWith(userId, body, expect.any(Object));
    const exposures = await post('/exposures', { batch_id: batchId, character_ids: [cardId] });
    expect(exposures.json().data.accepted).toBe(1);
    expect(mocks.exposures).toHaveBeenCalledWith(
      userId,
      { batch_id: batchId, character_ids: [cardId] },
      expect.any(Object)
    );
  });
  it('only opt-in requests load summaries and matching head IDs, dropping unavailable rows', async () => {
    const cards = [
      {
        id: cardId,
        name: 'test',
        description: '',
        avatar_url: '',
        personality_tags: [],
        author_name: '',
        is_featured: false,
      },
    ];
    mocks.get.mockImplementation(async () => ({
      enabled: true,
      batch_id: batchId,
      character_ids: [userId, cardId],
      head_ids: [userId, cardId],
    }));
    const old = await post('', { action: 'open', request_id: batchId });
    expect(old.json().data.head_cards).toBeUndefined();
    expect(mocks.headCards).not.toHaveBeenCalled();
    mocks.headCards.mockResolvedValue(cards);
    const next = await post('', { action: 'open', request_id: batchId, include_head_cards: true });
    expect(next.json().data).toMatchObject({
      head_ids: [cardId],
      character_ids: [cardId],
      head_cards: cards,
    });
  });

  it('rejects unknown actions, caller identity, and oversized exposure batches before storage', async () => {
    expect((await post('', { action: 'delete', request_id: batchId })).statusCode).toBe(400);
    expect(
      (await post('', { action: 'open', request_id: batchId, user_id: cardId })).statusCode
    ).toBe(400);
    expect(
      (await post('/exposures', { batch_id: batchId, character_ids: Array(41).fill(cardId) }))
        .statusCode
    ).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.exposures).not.toHaveBeenCalled();
  });
  it('returns a retryable failure without claiming that old cards were replaced', async () => {
    mocks.get.mockRejectedValue(new Error('synthetic storage unavailable'));
    const response = await post('', {
      action: 'refresh',
      request_id: batchId,
      expected_batch_id: cardId,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toContain('原来的推荐还在');
    expect(response.body).not.toContain('synthetic');
  });
});
