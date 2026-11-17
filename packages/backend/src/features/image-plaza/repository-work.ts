import {
  ImagePlazaSnapshotSchema,
  VideoPlazaSnapshotSchema,
  type ImagePlazaWork,
  type PlazaFeedItem,
  type PlazaWork,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import type { ArtifactRow, VideoArtifactRow, WorkRow } from './repository-model.js';
import { signPlazaImagePath, signSharedVideoPath, signSharedWorkImagePath } from './storage.js';

export class ImagePlazaWorkRepository {
  protected readonly mediaPlaza: ReturnType<typeof getDomainDb> = getDomainDb('media_plaza');
  protected readonly billing: ReturnType<typeof getDomainDb> = getDomainDb('billing');
  protected async hydrateFeedWorks(
    rows: WorkRow[],
    userId: string,
    options: { feedImages: true; includeReferences?: boolean; signal?: AbortSignal }
  ): Promise<PlazaFeedItem[]> {
    return (await this.hydrateWorks(rows, userId, options)) as PlazaFeedItem[];
  }

  protected async hydrateDetailWorks(rows: WorkRow[], userId: string): Promise<PlazaWork[]> {
    return (await this.hydrateWorks(rows, userId)) as PlazaWork[];
  }

  protected async hydrateWorks(
    rows: WorkRow[],
    userId: string,
    options: { feedImages?: boolean; includeReferences?: boolean; signal?: AbortSignal } = {}
  ): Promise<Array<PlazaWork | PlazaFeedItem>> {
    if (rows.length === 0) return [];
    const artifactIds = rows.flatMap((row) => (row.artifact_id ? [row.artifact_id] : []));
    const videoArtifactIds = rows.flatMap((row) =>
      row.video_artifact_id ? [row.video_artifact_id] : []
    );
    const workIds = rows.map((row) => row.id);
    const [imageResult, videoResult, likeResult] = await Promise.all([
      artifactIds.length > 0
        ? this.mediaPlaza
            .from('image_plaza_artifacts')
            .select('id,storage_path')
            .in('id', artifactIds)
            .abortSignal(options.signal ?? AbortSignal.timeout(10_000))
        : Promise.resolve({ data: [], error: null }),
      videoArtifactIds.length > 0
        ? this.mediaPlaza
            .from('video_artifacts')
            .select('*')
            .in('id', videoArtifactIds)
            .abortSignal(options.signal ?? AbortSignal.timeout(10_000))
        : Promise.resolve({ data: [], error: null }),
      this.mediaPlaza
        .from('image_plaza_likes')
        .select('work_id')
        .eq('user_id', userId)
        .in('work_id', workIds)
        .abortSignal(options.signal ?? AbortSignal.timeout(10_000)),
    ]);
    if (imageResult.error || videoResult.error || likeResult.error) {
      throw new Error('image_plaza_work_hydration_failed', {
        cause: imageResult.error ?? videoResult.error ?? likeResult.error,
      });
    }
    const artifacts = new Map(
      (imageResult.data ?? []).map((row) => [String(row.id), row as ArtifactRow])
    );
    const videoArtifacts = new Map(
      (videoResult.data ?? []).map((row) => [String(row.id), row as VideoArtifactRow])
    );
    const liked = new Set((likeResult.data ?? []).map((row) => String(row.work_id)));
    // Feed transformations stay parallel; per-key single-flight removes duplicate concurrent
    // signing calls without changing the 720px/quality-72 media shape.
    const imagePrepared = rows
      .filter((row) => row.media_type !== 'video')
      .map((row) => {
        const artifact = row.artifact_id ? artifacts.get(row.artifact_id) : undefined;
        const snapshot = ImagePlazaSnapshotSchema.safeParse(row.snapshot);
        if (!artifact || !snapshot.success) throw new Error('image_plaza_work_shape_invalid');
        const publishedAt = new Date(row.published_at);
        if (Number.isNaN(publishedAt.getTime())) throw new Error('image_plaza_work_shape_invalid');
        return { row, artifact, snapshot: snapshot.data, publishedAt };
      });
    const imagePreparedById = new Map(imagePrepared.map((item) => [item.row.id, item]));
    const imageUrlsPromise = Promise.all(
      imagePrepared.map(
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
      rows.map(async (row) => {
        const publishedAt = new Date(row.published_at);
        if (Number.isNaN(publishedAt.getTime())) throw new Error('image_plaza_work_shape_invalid');
        if (row.media_type === 'video') {
          return this.hydrateVideoWork(row, videoArtifacts, liked, publishedAt, options.feedImages);
        }
        const prepared = imagePreparedById.get(row.id);
        if (!prepared) throw new Error('image_plaza_work_shape_invalid');
        const { artifact, snapshot } = prepared;
        const [imageUrls, referenceImageUrl] = await Promise.all([
          imageUrlsPromise,
          this.resolveReferenceImageUrl(snapshot.reference_artifact_id, options),
        ]);
        const imageUrl = imageUrls.get(artifact.storage_path);
        if (!imageUrl) throw new Error('image_plaza_storage_sign_failed');
        const detail: ImagePlazaWork = {
          id: row.id,
          media_type: 'image' as const,
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
        if (!options.feedImages) return detail;
        const { reference_image_url: _reference, snapshot: _snapshot, ...summary } = detail;
        return summary;
      })
    );
    return works;
  }

  private async hydrateVideoWork(
    row: WorkRow,
    artifacts: Map<string, VideoArtifactRow>,
    liked: Set<string>,
    publishedAt: Date,
    feedImages?: boolean
  ): Promise<PlazaWork | PlazaFeedItem> {
    const artifact = row.video_artifact_id ? artifacts.get(row.video_artifact_id) : undefined;
    const snapshot = VideoPlazaSnapshotSchema.safeParse(row.snapshot);
    if (!artifact || !snapshot.success) throw new Error('image_plaza_work_shape_invalid');
    const posterUrl = artifact.poster_path ? await signSharedVideoPath(artifact.poster_path) : null;
    const summary = {
      id: row.id,
      media_type: 'video' as const,
      title: row.title,
      poster_url: posterUrl,
      duration_ms: artifact.duration_ms,
      description: row.description ?? '',
      model_id: row.model_id,
      model_name: row.model_name,
      width: row.width,
      height: row.height,
      tags: row.tags,
      like_count: row.like_count,
      liked: liked.has(row.id),
      published_at: publishedAt.toISOString(),
    };
    if (feedImages) return summary;
    return {
      ...summary,
      attempt_id: artifact.attempt_id,
      video_url: await signSharedVideoPath(artifact.storage_path),
      snapshot: snapshot.data,
    };
  }

  /**
   * 参考图属于未公开资产，仍用 15 分钟签名，不进作品图缓存。
   *
   * feed 明确传 `includeReferences: false`，所以这里的 DB 读取只在详情页发生；
   * 提出成方法是为了能让它在 `Promise.all` 里与作品图签名并行，而不是串行等待。
   */

  protected async resolveReferenceImageUrl(
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
