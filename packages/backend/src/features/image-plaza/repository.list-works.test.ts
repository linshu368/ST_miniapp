import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cursorFilter,
  decodeFeedCursor,
  encodeFeedCursor,
  feedFilter,
  type FeedCursor,
} from './feed-cursor.js';

type Call = { method: string; args: unknown[] };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  responses: [] as unknown[][],
}));

function createThenableBuilder(data: unknown[] = []) {
  const builder: Record<string, unknown> = {};
  const track =
    (method: string) =>
    (...args: unknown[]) => {
      state.calls.push({ method, args });
      return builder;
    };
  for (const method of [
    'select',
    'is',
    'order',
    'limit',
    'or',
    'filter',
    'contains',
    'eq',
    'in',
    'gt',
    'not',
    'abortSignal',
  ] as const) {
    builder[method] = track(method);
  }
  // Supabase query builders are thenable; empty page skips hydrate.
  builder.then = (
    onFulfilled?: (value: { data: unknown[]; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
  return builder;
}

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: (schema: string) => {
    if (schema === 'media_plaza') {
      return {
        from: (table: string) => {
          state.calls.push({ method: 'from', args: [table] });
          return createThenableBuilder(state.responses.shift() ?? []);
        },
      };
    }
    return {
      from: () => createThenableBuilder(),
      rpc: vi.fn(),
    };
  },
}));

vi.mock('./storage.js', () => ({
  deletePlazaImage: vi.fn(),
  downloadPlazaImage: vi.fn(),
  signPlazaImagePath: vi.fn(async () => 'https://example.com/image.png'),
  signSharedWorkImagePath: vi.fn(async () => 'https://example.com/image.png'),
  uploadPlazaImage: vi.fn(),
}));

const { ImagePlazaRepository } = await import('./repository.js');

describe('ImagePlazaRepository.listWorks tagLabel filter', () => {
  beforeEach(() => {
    state.calls = [];
  });

  it('filters prompt_zh with escaped ILIKE pattern and does not use tags contains', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      tagLabel: '人像_50%',
      limit: 20,
    });

    expect(state.calls.some((call) => call.method === 'contains')).toBe(false);
    const filterCall = state.calls.find((call) => call.method === 'filter');
    expect(filterCall?.args).toEqual(['snapshot->>prompt_zh', 'ilike', '%人像\\_50\\%%']);
  });

  it('does not apply tag filter when tagLabel is omitted (全部)', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({ userId: 'user-1', limit: 20 });

    expect(state.calls.some((call) => call.method === 'filter')).toBe(false);
    expect(state.calls.some((call) => call.method === 'contains')).toBe(false);
  });

  it('ANDs search or-clause with tagLabel filter', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      search: '猫',
      tagLabel: '动漫',
      limit: 20,
    });

    const orCall = state.calls.find((call) => call.method === 'or');
    expect(String(orCall?.args[0])).toContain('snapshot->>prompt.ilike.');
    expect(String(orCall?.args[0])).toContain('snapshot->>prompt_zh.ilike.');
    expect(state.calls.find((call) => call.method === 'filter')?.args).toEqual([
      'snapshot->>prompt_zh',
      'ilike',
      '%动漫%',
    ]);
  });
});

describe('versioned feed cursors', () => {
  const base = {
    v: 1 as const,
    filter: feedFilter('portrait', '肖像'),
    publishedAt: '2026-10-19T00:00:00.123456+00:00',
    id: '11111111-1111-4111-8111-111111111111',
  };
  const zero: FeedCursor = {
    ...base,
    sort: 'recommended',
    partition: 'zero',
    order: '9007199254740993',
  };
  it('round trips bigint strings above JS safe integer and timestamp microseconds', () => {
    expect(decodeFeedCursor(encodeFeedCursor(zero), 'recommended', base.filter)).toEqual(zero);
    expect(cursorFilter(zero)).toContain('initial_feed_order.gt.9007199254740993');
  });
  it('continues NULL tails without revisiting numbered works', () => {
    expect(cursorFilter({ ...zero, order: null })).toBe(
      `and(initial_feed_order.is.null,or(published_at.lt.${base.publishedAt},and(published_at.eq.${base.publishedAt},id.lt.${base.id})))`
    );
  });
  it('never includes initial order in liked tie breaks', () => {
    const liked: FeedCursor = { ...base, sort: 'recommended', partition: 'liked', likeCount: 3 };
    expect(cursorFilter(liked)).not.toContain('initial_feed_order');
    expect(cursorFilter(liked)).toContain('like_count.lt.3');
  });
  it('rejects wrong filter, sort, version, bigint overflow and malformed cursor', () => {
    const encoded = encodeFeedCursor(zero);
    expect(() => decodeFeedCursor(encoded, 'latest', base.filter)).toThrow(
      'IMAGE_PLAZA_INVALID_CURSOR'
    );
    expect(() => decodeFeedCursor(encoded, 'recommended', feedFilter())).toThrow(
      'IMAGE_PLAZA_INVALID_CURSOR'
    );
    for (const value of [
      { ...zero, v: 2 },
      { ...zero, order: '9223372036854775808' },
      { ...zero, order: 1 },
      { ...zero, id: 'bad,filter' },
    ]) {
      expect(() =>
        decodeFeedCursor(
          Buffer.from(JSON.stringify(value)).toString('base64url'),
          'recommended',
          base.filter
        )
      ).toThrow('IMAGE_PLAZA_INVALID_CURSOR');
    }
    expect(() => decodeFeedCursor('invalid!', 'recommended', base.filter)).toThrow(
      'IMAGE_PLAZA_INVALID_CURSOR'
    );
  });
  it('queries liked then zero, but a zero cursor queries only the zero section', async () => {
    state.calls = [];
    const repository = new ImagePlazaRepository();
    await repository.listWorks({ userId: 'user-1', sort: 'recommended', limit: 20 });
    expect(state.calls.filter((call) => call.method === 'from')).toHaveLength(2);
    expect(state.calls.find((call) => call.method === 'gt')?.args).toEqual(['like_count', 0]);
    expect(state.calls.find((call) => call.method === 'eq')?.args).toEqual(['like_count', 0]);
    state.calls = [];
    await repository.listWorks({
      userId: 'user-1',
      sort: 'recommended',
      search: 'portrait',
      tagLabel: '肖像',
      cursor: encodeFeedCursor(zero),
      limit: 20,
    });
    expect(state.calls.filter((call) => call.method === 'from')).toHaveLength(1);
    expect(state.calls.some((call) => call.method === 'gt')).toBe(false);
    expect(
      state.calls.filter((call) => call.method === 'order').map((call) => call.args[0])
    ).toEqual(['initial_feed_order', 'published_at', 'id']);
  });
  it('latest ignores likes/order and malformed new cursors fail before reads', async () => {
    state.calls = [];
    const repository = new ImagePlazaRepository();
    await repository.listWorks({ userId: 'user-1', sort: 'latest', limit: 20 });
    expect(
      state.calls.filter((call) => call.method === 'order').map((call) => call.args[0])
    ).toEqual(['published_at', 'id']);
    state.calls = [];
    await expect(
      repository.listWorks({ userId: 'user-1', sort: 'latest', cursor: 'invalid!', limit: 20 })
    ).rejects.toThrow('IMAGE_PLAZA_INVALID_CURSOR');
    expect(state.calls).toHaveLength(0);
  });

  it('stitches a partial liked page into zero works, excludes selected IDs and continues with a zero cursor', async () => {
    const row = (suffix: number, likes: number, order: string | null) => ({
      id: `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`,
      artifact_id: `artifact-${suffix}`,
      title: 'Example',
      model_id: 'model',
      model_name: 'Model',
      width: 512,
      height: 512,
      tags: [],
      like_count: likes,
      initial_feed_order: order,
      published_at: base.publishedAt,
      deleted_at: null,
      snapshot: {
        prompt: 'Example',
        model_id: 'model',
        aspect_ratio: '1:1',
        resolution: '1K',
        reasoning: false,
        auto_optimize: true,
        mode: 't2i',
        reference_artifact_id: null,
        style: 'None',
      },
    });
    const liked = row(1, 3, '99');
    const firstZero = row(2, 0, '1');
    const nextZero = row(3, 0, null);
    const artifacts = [liked, firstZero, nextZero].map((item) => ({
      id: item.artifact_id,
      storage_path: 'path',
    }));
    state.calls = [];
    state.responses = [[liked], [firstZero, nextZero], artifacts];
    const repository = new ImagePlazaRepository();
    const first = await repository.listWorks({ userId: 'owner', sort: 'recommended', limit: 2 });
    expect(first.works.map((item) => item.id)).toEqual([liked.id, firstZero.id]);
    expect(state.calls.find((call) => call.method === 'not')?.args).toEqual([
      'id',
      'in',
      `(${liked.id})`,
    ]);
    expect(
      decodeFeedCursor(first.nextCursor ?? undefined, 'recommended', feedFilter())
    ).toMatchObject({ partition: 'zero', order: '1' });
    state.responses = [[nextZero], artifacts];
    const second = await repository.listWorks({
      userId: 'owner',
      sort: 'recommended',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.works.map((item) => item.id)).toEqual([nextZero.id]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.works, ...second.works].map((item) => item.id)).size).toBe(3);
    state.responses = [];
  });
});
