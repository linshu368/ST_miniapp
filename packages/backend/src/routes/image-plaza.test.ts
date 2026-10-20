import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import imagePlazaRoutes from './image-plaza.js';

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  classify: vi.fn(),
  model: vi.fn(),
  prompt: vi.fn(),
  share: vi.fn(),
  work: vi.fn(),
  update: vi.fn(),
  user: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../features/image-plaza/config.js', () => ({
  getImagePlazaRuntimeConfig: mocks.runtime,
  publicImagePlazaFeedTags: () => [{ id: 'all', label: '全部' }],
}));
vi.mock('../features/image-plaza/tagging.js', async (original) => ({
  ...(await original<typeof import('../features/image-plaza/tagging.js')>()),
  classifyImagePlazaTags: mocks.classify,
}));
vi.mock('../features/image-plaza/repository.js', () => ({
  ImagePlazaRepository: class {
    getArtifactModelId = mocks.model;
    loadSharePrompt = mocks.prompt;
    shareArtifact = mocks.share;
    getWork = mocks.work;
    updateWorkTagsIfEmpty = mocks.update;
    listWorks = mocks.list;
  },
}));
vi.mock('../middleware/auth.js', () => ({ requireTelegramAuth: vi.fn(async () => {}) }));
vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: mocks.user,
}));
vi.mock('../platform/config.js', () => ({
  config: { imagePlaza: { workerEnabled: true, apiKey: '' } },
}));

const artifactId = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let storedTags: string[];
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'owner' });
  mocks.list.mockResolvedValue({ works: [], nextCursor: null });
  storedTags = [];
  mocks.runtime.mockResolvedValue({
    enabled: true,
    tagsFeatureEnabled: true,
    tags: [
      { id: 'portrait', label: '肖像', enabled: true, sort_order: 0 },
      { id: 'disabled', label: '禁用', enabled: false, sort_order: 1 },
    ],
    catalog: { models: [{ id: 'model', name: 'Model' }] },
    rebateRate: 0.1,
  });
  mocks.model.mockResolvedValue('model');
  mocks.prompt.mockResolvedValue('portrait description');
  mocks.classify.mockResolvedValue(['portrait']);
  mocks.share.mockImplementation(async (input: { tags: string[] }) => {
    storedTags = input.tags;
    return { workId: 'work', alreadyShared: false, rewardCredits: 10 };
  });
  mocks.work.mockImplementation(async () => ({ id: 'work', tags: [...storedTags] }));
  mocks.update.mockResolvedValue(true);
  app = Fastify();
  app.addHook('preHandler', async (request) => {
    Object.assign(request, { user: { id: 1 } });
  });
  await app.register(imagePlazaRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

function share(tags?: string[]) {
  return app.inject({
    method: 'POST',
    url: '/api/image-plaza/share',
    payload: { artifact_id: artifactId, title: 'Test artwork', ...(tags ? { tags } : {}) },
  });
}
function deferClassification() {
  let resolve!: (value: string[]) => void;
  mocks.classify.mockReturnValue(
    new Promise<string[]>((done) => {
      resolve = done;
    })
  );
  return (tags: string[]) => resolve(tags);
}

describe('image plaza feed contract', () => {
  it('passes explicit sort and normalized filters and preserves legacy omission', async () => {
    expect(
      (await app.inject('/api/image-plaza/feed?sort=recommended&tag=portrait&search=cat'))
        .statusCode
    ).toBe(200);
    expect(mocks.list).toHaveBeenLastCalledWith({
      userId: 'owner',
      sort: 'recommended',
      search: 'cat',
      tagLabel: '肖像',
      limit: 20,
    });
    expect((await app.inject('/api/image-plaza/feed')).statusCode).toBe(200);
    expect(mocks.list).toHaveBeenLastCalledWith({ userId: 'owner', limit: 20 });
  });
  it('rejects invalid sort and translates rejected cursor into a refreshable 400', async () => {
    expect((await app.inject('/api/image-plaza/feed?sort=heat')).statusCode).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.list.mockRejectedValueOnce(new Error('IMAGE_PLAZA_INVALID_CURSOR'));
    const result = await app.inject('/api/image-plaza/feed?sort=latest&cursor=old');
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('IMAGE_PLAZA_INVALID_CURSOR');
  });
});

describe('image plaza share auto tags', () => {
  it('preserves explicit client tags without loading prompt or calling LLM', async () => {
    const response = await share(['portrait']);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.work.tags).toEqual(['portrait']);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('skips auto tagging when tags feature is disabled', async () => {
    mocks.runtime.mockResolvedValueOnce({
      enabled: true,
      tagsFeatureEnabled: false,
      tags: [
        { id: 'portrait', label: '肖像', enabled: true, sort_order: 0 },
        { id: 'disabled', label: '禁用', enabled: false, sort_order: 1 },
      ],
      catalog: { models: [{ id: 'model', name: 'Model' }] },
      rebateRate: 0.1,
    });
    const response = await share([]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.work.tags).toEqual([]);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'disabled'])('rejects invalid client tag %s before sharing', async (tag) => {
    expect((await share([tag])).statusCode).toBe(400);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it('classifies omitted tags synchronously and retains reward semantics', async () => {
    const response = await share();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      work: { tags: ['portrait'] },
      reward_credits: 10,
      already_shared: false,
      has_completed_first_share: true,
    });
    expect(mocks.prompt).toHaveBeenCalledWith(artifactId, 'owner');
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.share).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('shares empty tags after 2 seconds then backfills without repeating the share RPC', async () => {
    const resolve = deferClassification();
    const response = await share([]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.work.tags).toEqual([]);
    expect(mocks.update).not.toHaveBeenCalled();
    resolve(['portrait']);
    await vi.waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('work', 'owner', ['portrait'])
    );
    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.share).toHaveBeenCalledOnce();
  });

  it('preserves the first snapshot on an already shared artifact', async () => {
    const resolve = deferClassification();
    mocks.share.mockResolvedValue({ workId: 'work', alreadyShared: true, rewardCredits: 0 });
    storedTags = ['portrait'];
    const response = await share([]);
    expect(response.json().data).toMatchObject({
      already_shared: true,
      reward_credits: 0,
      work: { tags: ['portrait'] },
    });
    resolve(['portrait']);
    await new Promise<void>((done) => setImmediate(done));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.share).toHaveBeenCalledOnce();
  });

  it('keeps sharing successful on prompt or synchronous classification failure', async () => {
    mocks.prompt.mockRejectedValueOnce(new Error('prompt unavailable'));
    expect((await share([])).statusCode).toBe(200);
    expect(mocks.classify).not.toHaveBeenCalled();
    mocks.classify.mockResolvedValueOnce([]);
    const response = await share([]);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.work.tags).toEqual([]);
  });

  it('handles empty late results and conditional update failure without affecting the response', async () => {
    const resolve = deferClassification();
    const response = await share([]);
    resolve([]);
    await new Promise<void>((done) => setImmediate(done));
    expect(response.statusCode).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    const next = deferClassification();
    mocks.update.mockRejectedValueOnce(new Error('image_plaza_tagging_update_failed'));
    const nextResponse = await share([]);
    next(['portrait']);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(nextResponse.statusCode).toBe(200);
    expect(mocks.share).toHaveBeenCalledTimes(2);
  });
});
