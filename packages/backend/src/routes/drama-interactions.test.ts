import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  denied: false,
  exists: vi.fn(),
  social: vi.fn(),
  setLike: vi.fn(),
  comments: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
}));
const dramaId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const commentId = '33333333-3333-4333-8333-333333333333';
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    if (mocks.denied) return reply.code(401).send({ error: 'unauthorized' });
    request.user = { id: 123, first_name: 'fixture' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: async () => ({ id: userId }) }));
vi.mock('../lib/logger.js', () => ({
  requestLogger: () => ({ biz: { info: vi.fn() }, sys: { error: vi.fn() } }),
}));
vi.mock('../features/drama/interactions.js', async (original) => {
  const actual = await original<typeof import('../features/drama/interactions.js')>();
  return {
    ...actual,
    DramaInteractionRepository: class {
      exists = mocks.exists;
      social = mocks.social;
      setLike = mocks.setLike;
      comments = mocks.comments;
      createComment = mocks.createComment;
      deleteComment = mocks.deleteComment;
    },
  };
});
import routes from './drama-interactions.js';
import { decodeCommentCursor } from '../features/drama/interactions.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.denied = false;
  mocks.exists.mockResolvedValue(true);
  mocks.social.mockResolvedValue({ liked: false, like_count: 0, comment_count: 0 });
  mocks.setLike.mockResolvedValue({ liked: true, like_count: 1, comment_count: 0 });
  mocks.comments.mockResolvedValue({ comments: [], next_cursor: null });
  mocks.createComment.mockResolvedValue({
    id: commentId,
    is_mine: true,
    author: '剧友',
    body: '节奏不错',
    created_at: new Date().toISOString(),
  });
});
async function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) {
  const app = Fastify();
  await app.register(routes);
  try {
    return await app.inject({ method, url: path, payload });
  } finally {
    await app.close();
  }
}
const base = `/api/dramas/${dramaId}`;

describe('official drama interactions', () => {
  it('requires Telegram auth before reading or writing', async () => {
    mocks.denied = true;
    expect(
      (await request('POST', `${base}/comments`, { id: commentId, body: '节奏不错' })).statusCode
    ).toBe(401);
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
  });
  it('rejects invalid identity, missing drama and malformed write input', async () => {
    expect((await request('GET', '/api/dramas/invalid/social')).statusCode).toBe(400);
    expect((await request('PUT', `${base}/like`, { liked: 'true' })).statusCode).toBe(400);
    for (const body of ['', ' ', 'x'.repeat(501), 'bad\u0000text'])
      expect((await request('POST', `${base}/comments`, { id: commentId, body })).statusCode).toBe(
        400
      );
    mocks.exists.mockResolvedValue(false);
    expect((await request('GET', `${base}/social`)).statusCode).toBe(404);
    expect(mocks.social).not.toHaveBeenCalled();
  });
  it('uses authenticated DB identity and desired-state likes', async () => {
    const response = await request('PUT', `${base}/like`, { liked: false });
    expect(response.statusCode).toBe(200);
    expect(mocks.setLike).toHaveBeenCalledWith(dramaId, userId, false);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('preserves comment idempotency keys, trims content and maps backpressure', async () => {
    await request('POST', `${base}/comments`, { id: commentId, body: ' 节奏不错 ' });
    expect(mocks.createComment).toHaveBeenCalledWith(dramaId, userId, commentId, '节奏不错');
    mocks.createComment.mockRejectedValue({ code: 'P0429' });
    expect(
      (await request('POST', `${base}/comments`, { id: commentId, body: '内容' })).statusCode
    ).toBe(429);
    mocks.createComment.mockRejectedValue({ code: '23505' });
    expect(
      (await request('POST', `${base}/comments`, { id: commentId, body: '内容' })).statusCode
    ).toBe(409);
  });
  it('passes author and drama constraints to deletion, never client-supplied user identity', async () => {
    const response = await request('DELETE', `${base}/comments/${commentId}`, {
      user_id: 'someone-else',
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.deleteComment).toHaveBeenCalledWith(dramaId, userId, commentId);
  });
  it('validates cursor fields before building database filters', async () => {
    const good = Buffer.from(
      JSON.stringify({ at: '2026-10-27T01:02:03.123456+00:00', id: commentId })
    ).toString('base64url');
    expect(decodeCommentCursor(good)?.id).toBe(commentId);
    expect((await request('GET', `${base}/comments?cursor=${good}`)).statusCode).toBe(200);
    const bad = Buffer.from(
      JSON.stringify({ at: '2026-10-27T01:02:03Z),user_id.neq.null', id: commentId })
    ).toString('base64url');
    expect(decodeCommentCursor(bad)).toBeNull();
    expect((await request('GET', `${base}/comments?cursor=${bad}`)).statusCode).toBe(400);
  });
  it('sanitizes infrastructure failures without exposing database details', async () => {
    mocks.social.mockRejectedValue(new Error('private schema connection details'));
    const response = await request('GET', `${base}/social`);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private schema');
  });
});
