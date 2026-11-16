import {
  ImagePlazaSnapshotSchema,
  type ImagePlazaWork,
  type ImagePlazaFeedSort,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import {
  cursorFilter,
  decodeFeedCursor,
  encodeFeedCursor,
  feedFilter,
  type FeedCursor,
} from './feed-cursor.js';
import { signPlazaImagePath, signSharedWorkImagePath } from './storage.js';
import {
  WorkRow,
  WORK_COLUMNS,
  ArtifactRow,
  escapeIlikePattern,
  quotePostgrestFilterValue,
  encodeCursor,
  decodeCursor,
} from './repository-model.js';

/** Feed reads and work metadata share the original domain clients. */
export class ImagePlazaFeedRepository {
  protected readonly mediaPlaza: ReturnType<typeof getDomainDb> = getDomainDb('media_plaza');
  private readonly appCore = getDomainDb('app_core');

  async hasCompletedFirstShare(userId: string): Promise<boolean> {
    const { data, error } = await this.appCore
      .from('miniapp_user_settings')
      .select('image_plaza_first_share_completed_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error)
      throw new Error(`image plaza settings read failed: ${error.message}`, { cause: error });
    return typeof data?.image_plaza_first_share_completed_at === 'string';
  }

  async listWorks(input: {
    userId: string;
    search?: string;
    /** 业务标签中文 label；按 snapshot.prompt_zh 字面包含匹配。未传则不做标签限制。 */
    tagLabel?: string;
    cursor?: string;
    sort?: ImagePlazaFeedSort;
    limit: number;
  }): Promise<{ works: ImagePlazaWork[]; nextCursor: string | null }> {
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
    if (input.tagLabel) {
      // 仅匹配中文译文；无 prompt_zh 的作品不会命中。不按 works.tags 数组筛选。
      const term = escapeIlikePattern(input.tagLabel.trim().slice(0, 80));
      if (term) {
        const pattern = `%${term}%`;
        query = query.filter('snapshot->>prompt_zh', 'ilike', pattern);
      }
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
    const works = await this.hydrateWorks(visible, input.userId, {
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
    tagLabel?: string;
    cursor?: string;
    sort: ImagePlazaFeedSort;
    limit: number;
  }): Promise<{ works: ImagePlazaWork[]; nextCursor: string | null }> {
    const filter = feedFilter(input.search, input.tagLabel);
    const cursor = decodeFeedCursor(input.cursor, input.sort, filter);
    const signal = AbortSignal.timeout(10_000);
    const read = async (
      partition: 'liked' | 'zero' | 'latest',
      limit: number,
      exclude: string[] = []
    ) => {
      // Cast bigint before JSON serialization; Number would silently lose deep cursor precision.
      let query = this.mediaPlaza
        .from('image_plaza_works')
        .select(WORK_COLUMNS)
        .is('deleted_at', null);
      if (partition === 'liked')
        query = query.gt('like_count', 0).order('like_count', { ascending: false });
      if (partition === 'zero')
        query = query
          .eq('like_count', 0)
          .order('initial_feed_order', { ascending: true, nullsFirst: false });
      query = query.order('published_at', { ascending: false }).order('id', { ascending: false });
      if (input.search?.trim()) {
        const pattern = quotePostgrestFilterValue(
          `%${escapeIlikePattern(input.search.trim().slice(0, 80))}%`
        );
        query = query.or(
          `snapshot->>prompt.ilike.${pattern},snapshot->>prompt_zh.ilike.${pattern}`
        );
      }
      if (input.tagLabel?.trim())
        query = query.filter(
          'snapshot->>prompt_zh',
          'ilike',
          `%${escapeIlikePattern(input.tagLabel.trim().slice(0, 80))}%`
        );
      if (cursor?.partition === partition) query = query.or(cursorFilter(cursor));
      // These IDs came from this bounded DB page, not arbitrary request filter syntax.
      if (exclude.length) query = query.not('id', 'in', `(${exclude.join(',')})`);
      const { data, error } = await query.limit(limit).abortSignal(signal);
      if (error) throw new Error('image plaza feed read failed', { cause: error });
      return (data ?? []) as WorkRow[];
    };
    let rows: WorkRow[];
    let likedRows = 0;
    if (input.sort === 'latest') rows = await read('latest', input.limit + 1);
    else {
      rows = cursor?.partition === 'zero' ? [] : await read('liked', input.limit + 1);
      likedRows = rows.length;
      if (rows.length <= input.limit) {
        rows.push(
          ...(await read(
            'zero',
            input.limit + 1 - rows.length,
            rows.map((row) => row.id)
          ))
        );
      }
    }
    const visible = rows.slice(0, input.limit);
    const last = visible.at(-1);
    let nextCursor: string | null = null;
    if (last && rows.length > input.limit) {
      const base = { v: 1 as const, filter, publishedAt: last.published_at, id: last.id };
      const next: FeedCursor =
        input.sort === 'latest'
          ? { ...base, sort: 'latest', partition: 'latest' }
          : visible.length <= likedRows
            ? { ...base, sort: 'recommended', partition: 'liked', likeCount: last.like_count }
            : {
                ...base,
                sort: 'recommended',
                partition: 'zero',
                order: last.initial_feed_order ?? null,
              };
      nextCursor = encodeFeedCursor(next);
    }
    return {
      works: await this.hydrateWorks(visible, input.userId, {
        feedImages: true,
        includeReferences: false,
        signal,
      }),
      nextCursor,
    };
  }

  async getWork(workId: string, userId: string): Promise<ImagePlazaWork | null> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_works')
      .select('*')
      .eq('id', workId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(`image plaza work read failed: ${error.message}`, { cause: error });
    if (!data) return null;
    return (await this.hydrateWorks([data as WorkRow], userId))[0] ?? null;
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

  private async hydrateWorks(
    rows: WorkRow[],
    userId: string,
    options: { feedImages?: boolean; includeReferences?: boolean; signal?: AbortSignal } = {}
  ): Promise<ImagePlazaWork[]> {
    if (rows.length === 0) return [];
    const artifactIds = rows.map((row) => row.artifact_id);
    const workIds = rows.map((row) => row.id);
    const [{ data: artifactData, error: artifactError }, { data: likeData, error: likeError }] =
      await Promise.all([
        this.mediaPlaza
          .from('image_plaza_artifacts')
          .select('id,storage_path')
          .in('id', artifactIds)
          .abortSignal(options.signal ?? AbortSignal.timeout(10_000)),
        this.mediaPlaza
          .from('image_plaza_likes')
          .select('work_id')
          .eq('user_id', userId)
          .in('work_id', workIds)
          .abortSignal(options.signal ?? AbortSignal.timeout(10_000)),
      ]);
    if (artifactError || likeError) {
      throw new Error('image_plaza_work_hydration_failed', {
        cause: artifactError ?? likeError,
      });
    }
    const artifacts = new Map(
      (artifactData ?? []).map((row) => [String(row.id), row as ArtifactRow])
    );
    const liked = new Set((likeData ?? []).map((row) => String(row.work_id)));
    // Feed transformations stay parallel; per-key single-flight removes duplicate concurrent
    // signing calls without changing the 720px/quality-72 media shape.
    const prepared = rows.map((row) => {
      const artifact = artifacts.get(row.artifact_id);
      const snapshot = ImagePlazaSnapshotSchema.safeParse(row.snapshot);
      if (!artifact || !snapshot.success) throw new Error('image_plaza_work_shape_invalid');
      const publishedAt = new Date(row.published_at);
      if (Number.isNaN(publishedAt.getTime())) throw new Error('image_plaza_work_shape_invalid');
      return { row, artifact, snapshot: snapshot.data, publishedAt };
    });
    const imageUrlsPromise = Promise.all(
      prepared.map(
        async ({ artifact }) =>
          [
            artifact.storage_path,
            await signSharedWorkImagePath(
              artifact.storage_path,
              options.feedImages ? { width: 720, quality: 72 } : undefined
            ),
          ] as const
      )
    ).then((entries) => new Map(entries));
    const works = await Promise.all(
      prepared.map(async ({ row, artifact, snapshot, publishedAt }) => {
        const [imageUrls, referenceImageUrl] = await Promise.all([
          imageUrlsPromise,
          this.resolveReferenceImageUrl(snapshot.reference_artifact_id, options),
        ]);
        const imageUrl = imageUrls.get(artifact.storage_path);
        if (!imageUrl) throw new Error('image_plaza_storage_sign_failed');
        return {
          id: row.id,
          title: row.title,
          image_url: imageUrl,
          reference_image_url: referenceImageUrl,
          model_id: row.model_id,
          model_name: row.model_name,
          width: row.width,
          height: row.height,
          tags: row.tags,
          like_count: row.like_count,
          liked: liked.has(row.id),
          published_at: publishedAt.toISOString(),
          snapshot,
        };
      })
    );
    return works;
  }

  /**
   * 参考图属于未公开资产，仍用 15 分钟签名，不进作品图缓存。
   *
   * feed 明确传 `includeReferences: false`，所以这里的 DB 读取只在详情页发生；
   * 提出成方法是为了能让它在 `Promise.all` 里与作品图签名并行，而不是串行等待。
   */
  private async resolveReferenceImageUrl(
    referenceArtifactId: string | null | undefined,
    options: { includeReferences?: boolean }
  ): Promise<string | null> {
    if (options.includeReferences === false || !referenceArtifactId) return null;
    const { data: reference } = await this.mediaPlaza
      .from('image_plaza_reference_assets')
      .select('storage_path')
      .eq('id', referenceArtifactId)
      .maybeSingle();
    if (!reference?.storage_path) return null;
    return signPlazaImagePath(String(reference.storage_path));
  }
}
