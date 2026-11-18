import { z } from 'zod';
import {
  IMAGE_PLAZA_INVALID_CURSOR,
  type ImagePlazaFeedSort,
  type PlazaFeedItem,
  type PlazaWork,
} from '@miniapp/shared';
import {
  cursorFilter,
  decodeFeedCursor,
  encodeFeedCursor,
  feedFilter,
  type FeedCursor,
} from './feed-cursor.js';
import {
  decodeCursor,
  encodeCursor,
  escapeIlikePattern,
  promptZhTagFilter,
  quotePostgrestFilterValue,
  WORK_COLUMNS,
  WorkRow,
} from './repository-model.js';
import { ImagePlazaWorkRepository } from './repository-work.js';

const RecommendedPageSchema = z.object({
  ranking_revision: z.string().uuid(),
  items: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          user_id: z.string().nullable().default(null),
          attempt_id: z.string().nullable().default(null),
          artifact_id: z.string().nullable().default(null),
          title: z.string(),
          model_id: z.string(),
          model_name: z.string(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          tags: z.array(z.string()),
          snapshot: z.unknown(),
          like_count: z.number().int().nonnegative(),
          published_at: z.string().datetime({ offset: true }),
          deleted_at: z.string().nullable(),
          initial_feed_order: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .nullable(),
          media_type: z.enum(['image', 'video']).default('image'),
          video_artifact_id: z.string().nullable().optional(),
          video_attempt_id: z.string().nullable().optional(),
          duration_ms: z.number().int().nonnegative().nullable().optional(),
          description: z.string().optional(),
        })
        .transform((row): WorkRow => ({ ...row, snapshot: row.snapshot }))
    )
    .max(21),
});

/** Feed reads and work metadata share the original domain clients. */
export class ImagePlazaFeedRepository extends ImagePlazaWorkRepository {
  /** 首发分享在同一事务里必写一条返利记录（返利为 0 也写），有记录即完成过。 */
  async hasCompletedFirstShare(userId: string): Promise<boolean> {
    const { data, error } = await this.billing
      .from('image_plaza_share_rewards')
      .select('id')
      .eq('user_id', userId)
      .limit(1);
    if (error)
      throw new Error(`image plaza share reward read failed: ${error.message}`, { cause: error });
    return (data ?? []).length > 0;
  }

  async listWorks(input: {
    userId: string;
    search?: string;
    /** 业务标签中文 label；按 snapshot.prompt_zh 字面 OR 包含匹配。未传则不做标签限制。 */
    tagLabels?: string[];
    media?: 'all' | 'image' | 'video';
    cursor?: string;
    sort?: ImagePlazaFeedSort;
    limit: number;
  }): Promise<{ works: PlazaFeedItem[]; nextCursor: string | null }> {
    if (input.sort) return this.listSortedWorks({ ...input, sort: input.sort });
    // Feed 排序：点赞数 ↓ → 分享时间 ↓ → id ↓（稳定游标）
    let query = this.mediaPlaza
      .from('image_plaza_works')
      .select(WORK_COLUMNS)
      .is('deleted_at', null)
      .order('like_count', { ascending: false })
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(input.limit + 1);
    if (input.search) {
      // 前后模糊匹配英文 prompt 或中文 prompt_zh，不是标题。
      const term = escapeIlikePattern(input.search.trim().slice(0, 80));
      if (term) {
        const pattern = `%${term}%`;
        query = query.or(
          `snapshot->>prompt.ilike.${quotePostgrestFilterValue(pattern)},snapshot->>prompt_zh.ilike.${quotePostgrestFilterValue(pattern)}`
        );
      }
    }
    if (input.media && input.media !== 'all') query = query.eq('media_type', input.media);
    const tagFilter = promptZhTagFilter(input.tagLabels);
    if (tagFilter) {
      // 仅匹配中文译文；无 prompt_zh 的作品不会命中。不按 works.tags 数组筛选。
      query = query.or(tagFilter);
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const like = cursor.likeCount;
      const published = cursor.publishedAt;
      const id = cursor.id;
      query = query.or(
        [
          `like_count.lt.${like}`,
          `and(like_count.eq.${like},published_at.lt.${published})`,
          `and(like_count.eq.${like},published_at.eq.${published},id.lt.${id})`,
        ].join(',')
      );
    }
    const { data, error } = await query;
    if (error) throw new Error('image plaza feed read failed', { cause: error });
    const rows = (data ?? []) as WorkRow[];
    const visible = rows.slice(0, input.limit);
    const works = await this.hydrateFeedWorks(visible, input.userId, {
      feedImages: true,
      includeReferences: false,
    });
    const last = visible.at(-1);
    return {
      works,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor(Number(last.like_count), last.published_at, last.id)
          : null,
    };
  }

  private async listSortedWorks(input: {
    userId: string;
    search?: string;
    tagLabels?: string[];
    media?: 'all' | 'image' | 'video';
    cursor?: string;
    sort: ImagePlazaFeedSort;
    limit: number;
  }): Promise<{ works: PlazaFeedItem[]; nextCursor: string | null }> {
    const filter = feedFilter(input.search, input.tagLabels, input.media);
    const cursor = decodeFeedCursor(input.cursor, input.sort, filter);
    const signal = AbortSignal.timeout(10_000);
    if (input.sort === 'recommended')
      return this.listRecommendedWorks(input, filter, cursor, signal);
    let query = this.mediaPlaza
      .from('image_plaza_works')
      .select(WORK_COLUMNS)
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false });
    if (input.media && input.media !== 'all') query = query.eq('media_type', input.media);
    const tagFilter = promptZhTagFilter(input.tagLabels);
    if (tagFilter) query = query.or(tagFilter);
    if (input.search?.trim()) {
      const pattern = quotePostgrestFilterValue(
        `%${escapeIlikePattern(input.search.trim().slice(0, 80))}%`
      );
      query = query.or(`snapshot->>prompt.ilike.${pattern},snapshot->>prompt_zh.ilike.${pattern}`);
    }
    if (cursor) query = query.or(cursorFilter(cursor));
    const { data, error } = await query.limit(input.limit + 1).abortSignal(signal);
    if (error) throw new Error('image plaza feed read failed', { cause: error });
    const rows = (data ?? []) as WorkRow[];
    const visible = rows.slice(0, input.limit);
    const last = visible.at(-1);
    let nextCursor: string | null = null;
    if (last && rows.length > input.limit) {
      const base = { v: 1 as const, filter, publishedAt: last.published_at, id: last.id };
      const next: FeedCursor = { ...base, sort: 'latest', partition: 'latest' };
      nextCursor = encodeFeedCursor(next);
    }
    return {
      works: await this.hydrateFeedWorks(visible, input.userId, {
        feedImages: true,
        includeReferences: false,
        signal,
      }),
      nextCursor,
    };
  }

  private async listRecommendedWorks(
    input: {
      userId: string;
      search?: string;
      tagLabels?: string[];
      media?: 'all' | 'image' | 'video';
      limit: number;
    },
    filter: string,
    cursor: FeedCursor | null,
    signal: AbortSignal
  ): Promise<{ works: PlazaFeedItem[]; nextCursor: string | null }> {
    if (cursor && cursor.v !== 2) throw new Error(IMAGE_PLAZA_INVALID_CURSOR);
    const { data, error } = await this.mediaPlaza
      .rpc('read_image_plaza_recommended_feed', {
        p_media: input.media ?? 'all',
        p_search: input.search?.trim() ?? '',
        p_tag_labels: input.tagLabels ?? [],
        p_limit: input.limit,
        p_revision: cursor?.v === 2 ? cursor.rankingRevision : null,
        p_partition: cursor?.partition ?? null,
        p_like_count: cursor?.partition === 'liked' ? cursor.likeCount : null,
        p_order: cursor?.partition === 'zero' ? cursor.order : null,
        p_id: cursor?.id ?? null,
      })
      .abortSignal(signal);
    if (error) {
      if (error.message === IMAGE_PLAZA_INVALID_CURSOR) throw new Error(IMAGE_PLAZA_INVALID_CURSOR);
      throw new Error('image plaza recommended feed read failed', { cause: error });
    }
    const page = RecommendedPageSchema.parse(data);
    const visible = page.items.slice(0, input.limit);
    const last = visible.at(-1);
    const nextCursor =
      last && page.items.length > input.limit
        ? encodeFeedCursor({
            v: 2,
            filter,
            id: last.id,
            sort: 'recommended',
            rankingRevision: page.ranking_revision,
            ...(last.like_count > 0
              ? { partition: 'liked' as const, likeCount: last.like_count }
              : { partition: 'zero' as const, order: last.initial_feed_order ?? null }),
          })
        : null;
    return {
      works: await this.hydrateFeedWorks(visible, input.userId, {
        feedImages: true,
        includeReferences: false,
        signal,
      }),
      nextCursor,
    };
  }

  async getWork(workId: string, userId: string): Promise<PlazaWork | null> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_works')
      .select('*')
      .eq('id', workId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(`image plaza work read failed: ${error.message}`, { cause: error });
    if (!data) return null;
    return (await this.hydrateDetailWorks([data as WorkRow], userId))[0] ?? null;
  }

  async setLike(
    userId: string,
    workId: string,
    liked: boolean
  ): Promise<{ liked: boolean; likeCount: number }> {
    const { data, error } = await this.mediaPlaza.rpc('set_image_plaza_like', {
      p_user_id: userId,
      p_work_id: workId,
      p_liked: liked,
    });
    if (error || !data || typeof data !== 'object') {
      throw new Error(`image plaza like failed: ${error?.message ?? 'invalid result'}`, {
        cause: error,
      });
    }
    const result = data as Record<string, unknown>;
    return { liked: result.liked === true, likeCount: Number(result.like_count ?? 0) };
  }

  async getArtifactModelId(artifactId: string, userId: string): Promise<string> {
    const { data: artifact, error: artifactError } = await this.mediaPlaza
      .from('image_plaza_artifacts')
      .select('attempt_id')
      .eq('id', artifactId)
      .maybeSingle();
    if (artifactError || !artifact) throw new Error('image_plaza_artifact_not_found');
    const { data: attempt, error: attemptError } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .select('model_id')
      .eq('id', String(artifact.attempt_id))
      .eq('user_id', userId)
      .eq('status', 'ready')
      .maybeSingle();
    if (attemptError || !attempt) throw new Error('image_plaza_artifact_not_found');
    return String(attempt.model_id);
  }

  async loadSharePrompt(artifactId: string, userId: string): Promise<string> {
    const { data: artifact, error: artifactError } = await this.mediaPlaza
      .from('image_plaza_artifacts')
      .select('attempt_id')
      .eq('id', artifactId)
      .maybeSingle();
    if (artifactError || !artifact) throw new Error('image_plaza_artifact_not_found');
    const { data: attempt, error: attemptError } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .select('prompt')
      .eq('id', String(artifact.attempt_id))
      .eq('user_id', userId)
      .eq('status', 'ready')
      .maybeSingle();
    if (attemptError || !attempt || typeof attempt.prompt !== 'string') {
      throw new Error('image_plaza_artifact_not_found');
    }
    return attempt.prompt;
  }

  async updateWorkTagsIfEmpty(workId: string, userId: string, tags: string[]): Promise<boolean> {
    if (tags.length === 0) return false;
    // 单次条件写保持并发安全；不调用分享 RPC，因此不会再次发放返利。
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_works')
      .update({ tags })
      .eq('id', workId)
      .eq('user_id', userId)
      .eq('tags', '{}')
      .is('deleted_at', null)
      .select('id');
    if (error) throw new Error('image_plaza_tagging_update_failed');
    return (data?.length ?? 0) > 0;
  }

  async countWorksByTags(input: {
    tags: Array<{ id: string; label: string }>;
    media?: 'all' | 'image' | 'video';
    search?: string;
  }): Promise<Record<string, number>> {
    const counts: Array<readonly [string, number]> = [];
    const concurrency = 6;
    for (let offset = 0; offset < input.tags.length; offset += concurrency) {
      const batch = input.tags.slice(offset, offset + concurrency);
      counts.push(
        ...(await Promise.all(
          batch.map(async (tag) => {
            let query = this.mediaPlaza
              .from('image_plaza_works')
              .select('id', { count: 'exact', head: true })
              .is('deleted_at', null)
              .filter(
                'snapshot->>prompt_zh',
                'ilike',
                `%${escapeIlikePattern(tag.label.trim().slice(0, 80))}%`
              );
            if (input.media && input.media !== 'all') query = query.eq('media_type', input.media);
            if (input.search?.trim()) {
              const pattern = quotePostgrestFilterValue(
                `%${escapeIlikePattern(input.search.trim().slice(0, 80))}%`
              );
              query = query.or(
                `snapshot->>prompt.ilike.${pattern},snapshot->>prompt_zh.ilike.${pattern}`
              );
            }
            const { count, error } = await query.abortSignal(AbortSignal.timeout(10_000));
            if (error) throw new Error('image plaza tag counts read failed', { cause: error });
            return [tag.id, count ?? 0] as const;
          })
        ))
      );
    }
    return Object.fromEntries(counts);
  }
}
