import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_REVIEW_REJECTED_CODE,
  CREATOR_REVIEW_UNAVAILABLE_CODE,
  emptyCharacterDraft,
  type CreatorCharacter,
} from '@miniapp/shared';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  material: vi.fn(),
  mutate: vi.fn(),
  review: vi.fn(),
  testReview: vi.fn(),
  admin: vi.fn(),
  user: vi.fn(),
  clearLobby: vi.fn(),
}));
vi.mock('../features/creator/repository.js', () => ({
  CreatorCharacterRepository: class {
    get = mocks.get;
    getReviewMaterial = mocks.material;
    mutate = mocks.mutate;
  },
}));
vi.mock('../features/generation/creator-review.js', () => ({
  reviewCreatorCharacter: mocks.review,
  testCreatorCharacterReview: mocks.testReview,
}));

vi.mock('../features/admin-access/session.js', () => {
  class AdminSessionError extends Error {
    constructor(
      readonly statusCode: 401 | 403,
      message: string
    ) {
      super(message);
      this.name = 'AdminSessionError';
    }
  }
  return { AdminSessionError, requireAdminActor: mocks.admin };
});
vi.mock('../middleware/auth.js', () => ({ requireTelegramAuth: vi.fn(async () => {}) }));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/lobby/featured-snapshot.js', () => ({
  clearLobbyFeaturedSnapshot: mocks.clearLobby,
}));
vi.mock('../platform/config.js', () => ({ config: { database: { target: 'test' } } }));
import creatorCharacterRoutes from './creator-characters.js';

const ownerId = '10000000-0000-4000-8000-000000000001';
const cardId = '10000000-0000-4000-8000-000000000002';
const coverId = '10000000-0000-4000-8000-000000000003';
const material = {
  name: '林舟',
  description: '旧书店的重逢',
  opening: '「好久不见。」',
  tags: ['日常'],
  systemPrompt: '服务器保存的背景和预设原文',
};
function card(): CreatorCharacter {
  return {
    id: cardId,
    owner_user_id: ownerId,
    name: material.name,
    description: material.description,
    cover_asset_id: coverId,
    cover_url: 'https://example.invalid/cover.png',
    tags: material.tags,
    draft: {
      ...emptyCharacterDraft(),
      name: material.name,
      description: material.description,
      opening: material.opening,
      background: '旧书店里等着一个人',
      tags: material.tags,
    },
    state: 'ready',
    visibility: 'private',
    review_status: 'not_submitted',
    review_message: null,
    revision: 2,
    submitted_revision: null,
    published_revision: 2,
    approved_revision: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
  };
}
let app: FastifyInstance;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: ownerId });
  mocks.admin.mockResolvedValue({ userId: ownerId, role: 'operator' });
  mocks.testReview.mockResolvedValue({ approved: true, reason: '测试通过' });
  mocks.get.mockResolvedValue(card());
  mocks.material.mockResolvedValue(material);
  mocks.review.mockResolvedValue({ approved: true, reason: '资料完整' });
  mocks.mutate.mockResolvedValue({
    ...card(),
    visibility: 'public',
    review_status: 'approved',
    revision: 3,
  });
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.user = { id: 1, first_name: 'Fixture' };
  });
  await app.register(creatorCharacterRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});
function publish(
  action: 'publish' | 'visibility' = 'publish',
  visibility: 'public' | 'private' = 'public',
  extra: Record<string, unknown> = {}
) {
  return app.inject({
    method: action === 'publish' ? 'POST' : 'PUT',
    url: '/api/creator/characters/' + cardId + '/' + action,
    payload: { expected_revision: 2, visibility, ...extra },
  });
}

describe('creator public publication review', () => {
  it.each(['publish', 'visibility'] as const)(
    'audits the owner-bound stored revision before public %s',
    async (action) => {
      expect((await publish(action)).statusCode).toBe(200);
      expect(mocks.get).toHaveBeenCalledWith(cardId, ownerId);
      expect(mocks.material).toHaveBeenCalledWith(cardId, ownerId, 2);
      expect(mocks.review).toHaveBeenCalledWith(material);
      expect(mocks.mutate).toHaveBeenCalledWith({
        ownerId,
        id: cardId,
        action,
        expectedRevision: 2,
        visibility: 'public',
        review: { approved: true, reason: '资料完整' },
      });
      expect(mocks.clearLobby).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['publish', 'visibility'] as const)('does not audit private %s', async (action) => {
    expect((await publish(action, 'private')).statusCode).toBe(200);
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.mutate.mock.calls[0]![0]).not.toHaveProperty('review');
  });

  it('returns a real content rejection without mutating the old card or clearing lobby data', async () => {
    mocks.get.mockResolvedValue({ ...card(), visibility: 'public', approved_revision: 1 });
    mocks.review.mockResolvedValue({ approved: false, reason: '请去掉站外转账广告。' });
    const result = await publish();
    expect(result.statusCode).toBe(422);
    expect(result.json()).toMatchObject({
      success: false,
      error: { code: CREATOR_REVIEW_REJECTED_CODE, message: '请去掉站外转账广告。' },
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.clearLobby).not.toHaveBeenCalled();
  });

  it('returns a retryable service error for invalid model output without leaking it', async () => {
    mocks.review.mockRejectedValue(
      Object.assign(new Error('untrusted provider body and prompt'), {
        code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      })
    );
    const result = await publish();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe(CREATOR_REVIEW_UNAVAILABLE_CODE);
    expect(result.body).not.toContain('untrusted');
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.clearLobby).not.toHaveBeenCalled();
  });

  it('does not let the browser supply a review decision', async () => {
    expect(
      (await publish('publish', 'public', { review: { approved: true, reason: 'bypass' } }))
        .statusCode
    ).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('checks owner access before looking up material or paying for a review', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('not owned'), { code: 'P0404' }));
    expect((await publish()).statusCode).toBe(404);
    expect(mocks.get).toHaveBeenCalledWith(cardId, ownerId);
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('replays a completed request through SQL without reviewing or publishing again', async () => {
    mocks.get.mockResolvedValue({ ...card(), revision: 3 });
    expect((await publish()).statusCode).toBe(200);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledWith({
      ownerId,
      id: cardId,
      action: 'publish',
      expectedRevision: 2,
      visibility: 'public',
    });
  });

  it('leaves stale mismatched requests to the SQL CAS without a model call', async () => {
    mocks.get.mockResolvedValue({ ...card(), revision: 4 });
    mocks.mutate.mockRejectedValue(Object.assign(new Error('stale'), { code: 'P0409' }));
    expect((await publish()).statusCode).toBe(409);
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('does not apply a reviewed result when the draft changed before final CAS', async () => {
    mocks.mutate.mockRejectedValue(
      Object.assign(new Error('edited during review'), { code: 'P0409' })
    );
    expect((await publish()).statusCode).toBe(409);
    expect(mocks.review).toHaveBeenCalledTimes(1);
    expect(mocks.clearLobby).not.toHaveBeenCalled();
  });

  it('checks required fields before spending a public review call', async () => {
    const incomplete = card();
    incomplete.draft.opening = '';
    mocks.get.mockResolvedValue(incomplete);
    const result = await publish();
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('MISSING_FIELDS');
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe('Admin review policy dry run', () => {
  function dryRun(payload: unknown = { prompt: '当前编辑中的审核正文', material }) {
    return app.inject({
      method: 'POST',
      url: '/api/admin/creator-characters/review-test',
      headers: { authorization: 'Bearer test-only-admin-session' },
      payload: payload as Record<string, unknown>,
    });
  }

  it('uses the current policy and material without reading or changing any real card', async () => {
    const response = await dryRun();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: { result: { approved: true, reason: '测试通过' } },
    });
    expect(mocks.admin).toHaveBeenCalledWith('Bearer test-only-admin-session', 'write');
    expect(mocks.testReview).toHaveBeenCalledWith({ prompt: '当前编辑中的审核正文', material });
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.material).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.clearLobby).not.toHaveBeenCalled();
  });

  it('returns a valid negative result as data rather than a failed publication', async () => {
    mocks.testReview.mockResolvedValue({ approved: false, reason: '请删除测试中的站外广告。' });
    const response = await dryRun();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.result).toEqual({
      approved: false,
      reason: '请删除测试中的站外广告。',
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it.each([401, 403] as const)(
    'denies unauthorized or wrong-environment operators with %s',
    async (status) => {
      const { AdminSessionError } = await import('../features/admin-access/session.js');
      mocks.admin.mockRejectedValue(new AdminSessionError(status, 'No access to this environment'));
      expect((await dryRun()).statusCode).toBe(status);
      expect(mocks.testReview).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled();
    }
  );

  it.each([
    { prompt: '', material },
    { prompt: '规则', material, review: { approved: true, reason: 'bypass' } },
    { prompt: '规则', material: { ...material, imageUrl: 'https://untrusted.invalid/' } },
    {
      prompt: '规则',
      material: { name: '', description: '', opening: '', tags: [], systemPrompt: '  ' },
    },
    { prompt: '规则', material: { ...material, systemPrompt: 'x'.repeat(250001) } },
  ])('rejects invalid or extra dry-run input before invoking the provider', async (payload) => {
    expect((await dryRun(payload)).statusCode).toBe(400);
    expect(mocks.testReview).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('keeps an invalid provider result a technical error without exposing its raw body', async () => {
    mocks.testReview.mockRejectedValue(
      Object.assign(new Error('private debug material and provider response'), {
        code: CREATOR_REVIEW_UNAVAILABLE_CODE,
      })
    );
    const response = await dryRun();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe(CREATOR_REVIEW_UNAVAILABLE_CODE);
    expect(response.body).not.toContain('private debug material');
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.clearLobby).not.toHaveBeenCalled();
  });
});

describe('retired manual creator review endpoints', () => {
  it.each([
    { method: 'GET' as const, path: '/api/admin/creator-characters?status=pending' },
    { method: 'GET' as const, path: '/api/admin/creator-characters/' + cardId },
    {
      method: 'POST' as const,
      path: '/api/admin/creator-characters/' + cardId + '/review',
    },
  ])(
    'returns 404 for $method $path without any review or user side effects',
    async ({ method, path }) => {
      const response = await app.inject({
        method,
        url: path,
        headers: { authorization: 'Bearer test-only-admin-session' },
        ...(method === 'POST' ? { payload: { submitted_revision: 2, decision: 'approve' } } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(mocks.admin).not.toHaveBeenCalled();
      expect(mocks.user).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.material).not.toHaveBeenCalled();
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(mocks.review).not.toHaveBeenCalled();
      expect(mocks.testReview).not.toHaveBeenCalled();
      expect(mocks.clearLobby).not.toHaveBeenCalled();
    }
  );
});
