import { Buffer } from 'node:buffer';
import {
  ImagePlazaSnapshotSchema,
  VideoPlazaSnapshotSchema,
  type ImagePlazaArtifact,
  type ImagePlazaAttempt,
  type ImagePlazaConversation,
  type ImagePlazaSnapshot,
  type ImagePlazaWork,
  type PlazaFeedItem,
  type PlazaWork,
  type VideoPlazaAttempt,
  type VideoPlazaSnapshot,
  type ImagePlazaFeedSort,
  type ProviderImagePlazaModel,
  type SubmitImagePlazaAttemptRequest,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import {
  cursorFilter,
  decodeFeedCursor,
  encodeFeedCursor,
  feedFilter,
  type FeedCursor,
} from './feed-cursor.js';
import {
  deletePlazaImage,
  downloadPlazaImage,
  signPlazaImagePath,
  signSharedWorkImagePath,
  signSharedVideoPath,
  signPrivateVideoPath,
  uploadPlazaImage,
  type PlazaMimeType,
} from './storage.js';

/** 结算响应未知与已确认未扣款必须分开，worker 才不会误删成果或误报成功。 */
export class ImagePlazaSettlementError extends Error {
  readonly outcomeUnknown: boolean;

  constructor(
    readonly code: 'image_plaza_settlement_outcome_unknown' | 'image_plaza_insufficient_balance',
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = 'ImagePlazaSettlementError';
    this.outcomeUnknown = code === 'image_plaza_settlement_outcome_unknown';
  }
}

export interface ImagePlazaWorkerAttempt {
  id: string;
  userId: string;
  prompt: string;
  providerModelId: string;
  editProviderModelId: string | null;
  sizingMode: ProviderImagePlazaModel['sizing_mode'];
  mode: 't2i' | 'i2i' | 'edit';
  aspectRatio: string;
  resolution: '1K' | '2K' | 'fixed';
  autoOptimize: boolean;
  referenceArtifactId: string | null;
}

interface WorkRow {
  id: string;
  user_id: string;
  attempt_id: string | null;
  artifact_id: string | null;
  media_type?: 'image' | 'video';
  video_artifact_id?: string | null;
  video_attempt_id?: string | null;
  duration_ms?: number | null;
  description?: string;
  title: string;
  model_id: string;
  model_name: string;
  width: number;
  height: number;
  tags: string[];
  snapshot: unknown;
  like_count: number;
  published_at: string;
  deleted_at: string | null;
  initial_feed_order?: string | null;
}

interface VideoArtifactRow {
  id: string;
  attempt_id: string;
  storage_path: string;
  poster_path: string | null;
  width: number;
  height: number;
  duration_ms: number;
}

interface VideoConversationAttemptRow {
  id: string;
  conversation_id: string;
  assistant_message_id: string;
  status: VideoPlazaAttempt['status'];
  error_code: string | null;
  quote_credits: number;
  model_id: string;
  input_mode: 't2v' | 'i2v' | 'r2v';
  duration_s: number;
  resolution: string;
  aspect_ratio: string | null;
  audio: boolean;
  reference_artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

const WORK_COLUMNS =
  'id,user_id,attempt_id,artifact_id,title,model_id,model_name,width,height,tags,snapshot,like_count,published_at,deleted_at,initial_feed_order::text,media_type,video_artifact_id,video_attempt_id,duration_ms,description';

interface ArtifactRow {
  id: string;
  attempt_id: string;
  position: number;
  storage_path: string;
  width: number;
  height: number;
}

interface AttemptRow {
  id: string;
  user_id: string;
  conversation_id: string;
  assistant_message_id: string;
  quote_credits: number;
  status: string;
  error_code: string | null;
  reference_artifact_id: string | null;
  quote_id: string;
  prompt: string;
  model_id: string;
  mode: 't2i' | 'i2i' | 'edit';
  aspect_ratio: string;
  resolution: '1K' | '2K' | 'fixed';
  reasoning: boolean;
  auto_optimize: boolean;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  media_type?: 'image' | 'video';
  video_attempt_id?: string | null;
  created_at: string;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  snapshot: unknown;
  created_at: string;
  updated_at: string;
}

export class ImagePlazaRepository {
  private readonly plaza = getDomainDb('media_plaza');
  private readonly billing = getDomainDb('billing');
  private readonly appCore = getDomainDb('app_core');

  async hasCompletedFirstShare(userId: string): Promise<boolean> {
    const { data, error } = await this.appCore
      .from('miniapp_user_settings')
      .select('image_plaza_first_share_completed_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`image plaza settings read failed: ${error.message}`);
    return typeof data?.image_plaza_first_share_completed_at === 'string';
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
    let query = this.plaza
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
    const read = async (
      partition: 'liked' | 'zero' | 'latest',
      limit: number,
      exclude: string[] = []
    ) => {
      // Cast bigint before JSON serialization; Number would silently lose deep cursor precision.
      let query = this.plaza.from('image_plaza_works').select(WORK_COLUMNS).is('deleted_at', null);
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
      if (input.media && input.media !== 'all') query = query.eq('media_type', input.media);
      const tagFilter = promptZhTagFilter(input.tagLabels);
      if (tagFilter) query = query.or(tagFilter);
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
      works: await this.hydrateFeedWorks(visible, input.userId, {
        feedImages: true,
        includeReferences: false,
        signal,
      }),
      nextCursor,
    };
  }

  async getWork(workId: string, userId: string): Promise<PlazaWork | null> {
    const { data, error } = await this.plaza
      .from('image_plaza_works')
      .select('*')
      .eq('id', workId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(`image plaza work read failed: ${error.message}`);
    if (!data) return null;
    return (await this.hydrateDetailWorks([data as WorkRow], userId))[0] ?? null;
  }

  async setLike(
    userId: string,
    workId: string,
    liked: boolean
  ): Promise<{ liked: boolean; likeCount: number }> {
    const { data, error } = await this.plaza.rpc('set_image_plaza_like', {
      p_user_id: userId,
      p_work_id: workId,
      p_liked: liked,
    });
    if (error || !data || typeof data !== 'object') {
      throw new Error(`image plaza like failed: ${error?.message ?? 'invalid result'}`);
    }
    const result = data as Record<string, unknown>;
    return { liked: result.liked === true, likeCount: Number(result.like_count ?? 0) };
  }

  async createQuote(input: {
    userId: string;
    model: ProviderImagePlazaModel;
    aspectRatio: string;
    resolution: '1K' | '2K' | 'fixed';
    mode: 't2i' | 'i2i' | 'edit';
    catalogVersion: number;
  }): Promise<{ id: string; credits: number; expiresAt: string }> {
    const tier = input.model.resolutions.find((item) => item.id === input.resolution);
    if (!tier || !input.model.aspect_ratios.includes(input.aspectRatio as never)) {
      throw new Error('image_plaza_quote_option_invalid');
    }
    if (input.mode !== 't2i' && !input.model.supports_i2i) {
      throw new Error('image_plaza_model_does_not_support_reference');
    }
    if (input.mode === 'edit' && !input.model.supports_edit) {
      throw new Error('image_plaza_model_does_not_support_edit');
    }
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const { data, error } = await this.plaza
      .from('image_plaza_quotes')
      .insert({
        user_id: input.userId,
        model_id: input.model.id,
        provider_model_id: input.model.provider_model_id,
        edit_provider_model_id: input.model.edit_provider_model_id,
        sizing_mode: input.model.sizing_mode,
        mode: input.mode,
        aspect_ratio: input.aspectRatio,
        resolution: input.resolution,
        credits: tier.credits,
        catalog_version: input.catalogVersion,
        expires_at: expiresAt,
      })
      .select('id,credits,expires_at')
      .single();
    if (error || !data) throw new Error(`image plaza quote create failed: ${error?.message}`);
    return {
      id: String(data.id),
      credits: Number(data.credits),
      expiresAt: String(data.expires_at),
    };
  }

  async uploadReference(input: {
    userId: string;
    bytes: Buffer;
    mimeType: PlazaMimeType;
  }): Promise<ImagePlazaArtifact> {
    const referenceId = crypto.randomUUID();
    const stored = await uploadPlazaImage({
      userId: input.userId,
      namespace: 'references',
      ownerId: referenceId,
      position: 0,
      bytes: input.bytes,
      declaredMimeType: input.mimeType,
    });
    const { data, error } = await this.plaza
      .from('image_plaza_reference_assets')
      .insert({
        id: referenceId,
        user_id: input.userId,
        storage_path: stored.storagePath,
        mime_type: stored.mimeType,
        byte_size: stored.byteSize,
        width: stored.width,
        height: stored.height,
      })
      .select('id,storage_path,width,height')
      .single();
    if (error || !data) {
      await deletePlazaImage(stored.storagePath).catch(() => undefined);
      throw new Error(`image plaza reference create failed: ${error?.message}`);
    }
    return {
      id: String(data.id),
      image_url: await signPlazaImagePath(String(data.storage_path)),
      width: Number(data.width),
      height: Number(data.height),
    };
  }

  async createConversation(userId: string, sourceWorkId?: string): Promise<ImagePlazaConversation> {
    let title = '新建影像创作';
    let snapshot: ImagePlazaSnapshot | VideoPlazaSnapshot | null = null;
    if (sourceWorkId) {
      const { data, error } = await this.plaza
        .from('image_plaza_works')
        .select('title,snapshot,media_type')
        .eq('id', sourceWorkId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error || !data) throw new Error('image_plaza_source_work_not_found');
      const parsed =
        data.media_type === 'video'
          ? VideoPlazaSnapshotSchema.safeParse(data.snapshot)
          : ImagePlazaSnapshotSchema.safeParse(data.snapshot);
      if (!parsed.success) throw new Error('image_plaza_source_snapshot_invalid');
      title = `同款 · ${String(data.title).slice(0, 68)}`;
      // 同款会话只保留英文 prompt；中文译文仅用于作品详情展示与列表搜索。
      const { prompt_zh: _promptZh, ...useSameSnapshot } = parsed.data;
      snapshot = useSameSnapshot;
    }
    const { data, error } = await this.plaza
      .from('image_plaza_conversations')
      .insert({ user_id: userId, title, source_work_id: sourceWorkId ?? null, snapshot })
      .select('*')
      .single();
    if (error || !data)
      throw new Error(`image plaza conversation create failed: ${error?.message}`);
    // 新建会话必然没有消息和任务，直接映射可省掉两次空表读取，缩短“用同款”跳转等待。
    return mapConversationRow(data as ConversationRow, []);
  }

  async listConversations(
    userId: string
  ): Promise<Array<Omit<ImagePlazaConversation, 'messages'>>> {
    const { data, error } = await this.plaza
      .from('image_plaza_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(`image plaza conversations read failed: ${error.message}`);
    return (data ?? []).map((row) => {
      const conversation = mapConversationRow(row as ConversationRow, []);
      const { messages: _messages, ...summary } = conversation;
      return summary;
    });
  }

  async getConversation(
    conversationId: string,
    userId: string
  ): Promise<ImagePlazaConversation | null> {
    const { data, error } = await this.plaza
      .from('image_plaza_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`image plaza conversation read failed: ${error.message}`);
    return data ? this.hydrateConversation(data as ConversationRow) : null;
  }

  async createAttempt(input: {
    userId: string;
    conversationId: string;
    body: SubmitImagePlazaAttemptRequest;
    model: ProviderImagePlazaModel;
  }): Promise<ImagePlazaAttempt> {
    const existing = await this.findAttemptByIdempotency(
      input.userId,
      input.body.idempotency_key,
      input.body
    );
    if (existing) return existing;
    const [{ data: conversation }, { data: quote }, wallet] = await Promise.all([
      this.plaza
        .from('image_plaza_conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', input.userId)
        .maybeSingle(),
      this.plaza
        .from('image_plaza_quotes')
        .select('*')
        .eq('id', input.body.quote_id)
        .eq('user_id', input.userId)
        .maybeSingle(),
      this.billing
        .from('user_wallets')
        .select('main_credits,bonus_credits')
        .eq('user_id', input.userId)
        .maybeSingle(),
    ]);
    if (!conversation) throw new Error('image_plaza_conversation_not_found');
    if (!quote || new Date(String(quote.expires_at)).getTime() <= Date.now())
      throw new Error('image_plaza_quote_expired');
    if (
      quote.model_id !== input.body.model_id ||
      quote.aspect_ratio !== input.body.aspect_ratio ||
      quote.resolution !== input.body.resolution ||
      quote.mode !== input.body.mode
    )
      throw new Error('image_plaza_quote_mismatch');
    const balance =
      Number(wallet.data?.main_credits ?? 0) + Number(wallet.data?.bonus_credits ?? 0);
    if (balance < Number(quote.credits)) throw new Error('image_plaza_insufficient_balance');
    if (input.body.reference_artifact_id) {
      if (!(await this.canAccessReference(input.body.reference_artifact_id, input.userId))) {
        throw new Error('image_plaza_reference_not_found');
      }
    }
    if ((input.body.mode !== 't2i') !== Boolean(input.body.reference_artifact_id)) {
      throw new Error('image_plaza_reference_mode_mismatch');
    }
    const { data: userMessage, error: userError } = await this.plaza
      .from('image_plaza_messages')
      .insert({ conversation_id: input.conversationId, role: 'user', content: input.body.prompt })
      .select('id')
      .single();
    if (userError || !userMessage)
      throw new Error(`image plaza message create failed: ${userError?.message}`);
    const { data: assistantMessage, error: assistantError } = await this.plaza
      .from('image_plaza_messages')
      .insert({ conversation_id: input.conversationId, role: 'assistant', content: '生成中' })
      .select('id')
      .single();
    if (assistantError || !assistantMessage) {
      await this.plaza.from('image_plaza_messages').delete().eq('id', userMessage.id);
      throw new Error(`image plaza placeholder create failed: ${assistantError?.message}`);
    }
    const { data: attempt, error: attemptError } = await this.plaza
      .from('image_plaza_attempts')
      .insert({
        user_id: input.userId,
        conversation_id: input.conversationId,
        user_message_id: userMessage.id,
        assistant_message_id: assistantMessage.id,
        quote_id: input.body.quote_id,
        idempotency_key: input.body.idempotency_key,
        prompt: input.body.prompt,
        model_id: input.model.id,
        provider_model_id: quote.provider_model_id,
        edit_provider_model_id: quote.edit_provider_model_id,
        sizing_mode: quote.sizing_mode,
        mode: input.body.mode,
        aspect_ratio: input.body.aspect_ratio,
        resolution: input.body.resolution,
        reasoning: input.body.reasoning,
        auto_optimize: input.body.auto_optimize,
        reference_artifact_id: input.body.reference_artifact_id ?? null,
        quote_credits: quote.credits,
      })
      .select('*')
      .single();
    if (attemptError || !attempt) {
      await this.plaza
        .from('image_plaza_messages')
        .delete()
        .in('id', [userMessage.id, assistantMessage.id]);
      const raced = await this.findAttemptByIdempotency(
        input.userId,
        input.body.idempotency_key,
        input.body
      );
      if (raced) return raced;
      throw new Error(`image plaza attempt create failed: ${attemptError?.message}`);
    }
    await this.plaza
      .from('image_plaza_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', input.conversationId);
    return mapAttemptRow(attempt as AttemptRow, []);
  }

  async getAttempt(attemptId: string, userId: string): Promise<ImagePlazaAttempt | null> {
    const { data, error } = await this.plaza
      .from('image_plaza_attempts')
      .select('*')
      .eq('id', attemptId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`image plaza attempt read failed: ${error.message}`);
    if (!data) return null;
    const artifacts = await this.getArtifacts([attemptId]);
    return mapAttemptRow(data as AttemptRow, artifacts.get(attemptId) ?? []);
  }

  async shareArtifact(input: {
    userId: string;
    artifactId: string;
    title: string;
    modelName: string;
    tags: string[];
    rebateRate: number;
  }): Promise<{ workId: string; alreadyShared: boolean; rewardCredits: number }> {
    const { data, error } = await this.billing.rpc('share_image_plaza_artifact', {
      p_user_id: input.userId,
      p_artifact_id: input.artifactId,
      p_title: input.title,
      p_model_name: input.modelName,
      p_tags: input.tags,
      p_rebate_rate: input.rebateRate,
    });
    if (error) throw new Error(`image plaza share failed: ${error.message}`);
    const result = data as {
      work_id?: unknown;
      already_shared?: unknown;
      reward_credits?: unknown;
    };
    if (typeof result.work_id !== 'string') throw new Error('image_plaza_share_result_invalid');
    return {
      workId: result.work_id,
      alreadyShared: result.already_shared === true,
      rewardCredits: Number(result.reward_credits ?? 0),
    };
  }

  async getArtifactModelId(artifactId: string, userId: string): Promise<string> {
    const { data: artifact, error: artifactError } = await this.plaza
      .from('image_plaza_artifacts')
      .select('attempt_id')
      .eq('id', artifactId)
      .maybeSingle();
    if (artifactError || !artifact) throw new Error('image_plaza_artifact_not_found');
    const { data: attempt, error: attemptError } = await this.plaza
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
    const { data: artifact, error: artifactError } = await this.plaza
      .from('image_plaza_artifacts')
      .select('attempt_id')
      .eq('id', artifactId)
      .maybeSingle();
    if (artifactError || !artifact) throw new Error('image_plaza_artifact_not_found');
    const { data: attempt, error: attemptError } = await this.plaza
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
    const { data, error } = await this.plaza
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

  async claimJobs(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<ImagePlazaWorkerAttempt[]> {
    const { data, error } = await this.plaza.rpc('claim_image_plaza_jobs', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`image plaza claim failed: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      prompt: String(row.prompt),
      providerModelId: String(row.provider_model_id),
      editProviderModelId:
        typeof row.edit_provider_model_id === 'string' ? row.edit_provider_model_id : null,
      sizingMode: row.sizing_mode as ImagePlazaWorkerAttempt['sizingMode'],
      mode: row.mode as ImagePlazaWorkerAttempt['mode'],
      aspectRatio: String(row.aspect_ratio),
      resolution: row.resolution as ImagePlazaWorkerAttempt['resolution'],
      autoOptimize: row.auto_optimize !== false,
      referenceArtifactId:
        typeof row.reference_artifact_id === 'string' ? row.reference_artifact_id : null,
    }));
  }

  async markGenerating(attemptId: string, providerRequestId?: string | null): Promise<void> {
    const { error } = await this.plaza
      .from('image_plaza_attempts')
      .update({
        status: 'generating',
        provider_request_id: providerRequestId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('status', 'leased');
    if (error) throw new Error(`image plaza attempt update failed: ${error.message}`);
  }

  async recordProviderRequestId(
    attemptId: string,
    providerRequestId: string | null
  ): Promise<void> {
    if (!providerRequestId) return;
    const { error } = await this.plaza
      .from('image_plaza_attempts')
      .update({ provider_request_id: providerRequestId.slice(0, 240) })
      .eq('id', attemptId)
      .eq('status', 'generating');
    if (error) throw new Error(`image plaza provider request update failed: ${error.message}`);
  }

  async markFailed(attemptId: string, code: string, outcomeUnknown: boolean): Promise<void> {
    const { error } = await this.plaza
      .from('image_plaza_attempts')
      .update({
        status: outcomeUnknown ? 'failed_unknown' : 'failed',
        error_code: code.slice(0, 120),
        lease_owner: null,
        lease_expires_at: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .in('status', ['leased', 'generating', 'storing']);
    if (error) throw new Error(`image plaza failure update failed: ${error.message}`);
  }

  async markStaleDispatchedUnknown(olderThanIso: string): Promise<void> {
    const { error } = await this.plaza
      .from('image_plaza_attempts')
      .update({
        status: 'failed_unknown',
        error_code: 'image_plaza_worker_interrupted',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('status', ['generating', 'storing'])
      .lt('lease_expires_at', olderThanIso);
    if (error) throw new Error(`image plaza stale reconciliation failed: ${error.message}`);
  }

  async loadReference(
    referenceId: string,
    userId: string
  ): Promise<{ bytes: Buffer; mimeType: PlazaMimeType }> {
    const { data, error } = await this.plaza
      .from('image_plaza_reference_assets')
      .select('storage_path,mime_type,user_id')
      .eq('id', referenceId)
      .maybeSingle();
    if (error || !data) throw new Error('image_plaza_reference_not_found');
    if (String(data.user_id) !== userId && !(await this.canAccessReference(referenceId, userId))) {
      throw new Error('image_plaza_reference_not_found');
    }
    return {
      bytes: await downloadPlazaImage(String(data.storage_path)),
      mimeType: String(data.mime_type) as PlazaMimeType,
    };
  }

  async settleGeneratedImage(input: {
    attempt: ImagePlazaWorkerAttempt;
    bytes: Buffer;
    mimeType: PlazaMimeType;
  }): Promise<void> {
    const stored = await uploadPlazaImage({
      userId: input.attempt.userId,
      namespace: 'attempts',
      ownerId: input.attempt.id,
      position: 0,
      bytes: input.bytes,
      declaredMimeType: input.mimeType,
    });
    await this.plaza
      .from('image_plaza_attempts')
      .update({ status: 'storing', updated_at: new Date().toISOString() })
      .eq('id', input.attempt.id)
      .eq('status', 'generating');
    let result: { data: unknown; error: unknown };
    try {
      result = await this.billing.rpc('settle_image_plaza_generation', {
        p_attempt_id: input.attempt.id,
        p_user_id: input.attempt.userId,
        p_artifacts: [
          {
            position: 0,
            storage_path: stored.storagePath,
            mime_type: stored.mimeType,
            byte_size: stored.byteSize,
            width: stored.width,
            height: stored.height,
          },
        ],
      });
    } catch (cause) {
      throw new ImagePlazaSettlementError('image_plaza_settlement_outcome_unknown', { cause });
    }
    // RPC 可能已经提交后才丢失响应。error 优先于任何 data，未知时保图且不重投。
    if (result.error) {
      throw new ImagePlazaSettlementError('image_plaza_settlement_outcome_unknown', {
        cause: result.error,
      });
    }
    const status =
      result.data && typeof result.data === 'object'
        ? String((result.data as Record<string, unknown>).status ?? '')
        : '';
    if (status === 'settled' || status === 'already_settled') return;
    if (status === 'insufficient_balance') {
      try {
        await deletePlazaImage(stored.storagePath);
      } catch (cause) {
        throw new ImagePlazaSettlementError('image_plaza_insufficient_balance', { cause });
      }
      throw new ImagePlazaSettlementError('image_plaza_insufficient_balance');
    }
    throw new ImagePlazaSettlementError('image_plaza_settlement_outcome_unknown');
  }

  private async hydrateFeedWorks(
    rows: WorkRow[],
    userId: string,
    options: { feedImages: true; includeReferences?: boolean; signal?: AbortSignal }
  ): Promise<PlazaFeedItem[]> {
    return (await this.hydrateWorks(rows, userId, options)) as PlazaFeedItem[];
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
            let query = this.plaza
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

  private async hydrateDetailWorks(rows: WorkRow[], userId: string): Promise<PlazaWork[]> {
    return (await this.hydrateWorks(rows, userId)) as PlazaWork[];
  }

  private async hydrateWorks(
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
        ? this.plaza
            .from('image_plaza_artifacts')
            .select('id,storage_path')
            .in('id', artifactIds)
            .abortSignal(options.signal ?? AbortSignal.timeout(10_000))
        : Promise.resolve({ data: [], error: null }),
      videoArtifactIds.length > 0
        ? this.plaza
            .from('video_artifacts')
            .select('*')
            .in('id', videoArtifactIds)
            .abortSignal(options.signal ?? AbortSignal.timeout(10_000))
        : Promise.resolve({ data: [], error: null }),
      this.plaza
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
          const artifact = row.video_artifact_id
            ? videoArtifacts.get(row.video_artifact_id)
            : undefined;
          const snapshot = VideoPlazaSnapshotSchema.safeParse(row.snapshot);
          if (!artifact || !snapshot.success) throw new Error('image_plaza_work_shape_invalid');
          const posterUrl = artifact.poster_path
            ? await signSharedVideoPath(artifact.poster_path)
            : null;
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
          if (options.feedImages) return summary;
          return {
            ...summary,
            attempt_id: artifact.attempt_id,
            video_url: await signSharedVideoPath(artifact.storage_path),
            snapshot: snapshot.data,
          };
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
    const { data: reference } = await this.plaza
      .from('image_plaza_reference_assets')
      .select('storage_path')
      .eq('id', referenceArtifactId)
      .maybeSingle();
    if (!reference?.storage_path) return null;
    return signPlazaImagePath(String(reference.storage_path));
  }

  private async hydrateConversation(row: ConversationRow): Promise<ImagePlazaConversation> {
    const [
      { data: messages, error: messageError },
      { data: attempts, error: attemptError },
      videoResult,
    ] = await Promise.all([
      this.plaza
        .from('image_plaza_messages')
        .select('*')
        .eq('conversation_id', row.id)
        .order('created_at'),
      this.plaza.from('image_plaza_attempts').select('*').eq('conversation_id', row.id),
      this.plaza.from('video_attempts').select('*').eq('conversation_id', row.id),
    ]);
    const videoMissing = ['42P01', 'PGRST205'].includes(videoResult.error?.code ?? '');
    if (messageError || attemptError || (videoResult.error && !videoMissing))
      throw new Error('image_plaza_conversation_hydration_failed');
    const attemptRows = (attempts ?? []) as AttemptRow[];
    const artifacts = await this.getArtifacts(attemptRows.map((attempt) => attempt.id));
    const byAssistantMessage = new Map(
      attemptRows.map((attempt) => [
        attempt.assistant_message_id,
        mapAttemptRow(attempt, artifacts.get(attempt.id) ?? []),
      ])
    );
    const videoRows = videoMissing
      ? []
      : ((videoResult.data ?? []) as VideoConversationAttemptRow[]);
    const videoArtifacts = await this.getVideoArtifacts(videoRows.map((attempt) => attempt.id));
    const videoByAssistantMessage = new Map(
      await Promise.all(
        videoRows.map(
          async (attempt) =>
            [
              attempt.assistant_message_id,
              await mapVideoConversationAttempt(attempt, videoArtifacts.get(attempt.id) ?? null),
            ] as const
        )
      )
    );
    return mapConversationRow(
      row,
      ((messages ?? []) as MessageRow[]).map((message) => ({
        ...message,
        attempt: byAssistantMessage.get(message.id) ?? null,
        videoAttempt: videoByAssistantMessage.get(message.id) ?? null,
      }))
    );
  }

  private async getVideoArtifacts(attemptIds: string[]): Promise<Map<string, VideoArtifactRow>> {
    const result = new Map<string, VideoArtifactRow>();
    if (attemptIds.length === 0) return result;
    const { data, error } = await this.plaza
      .from('video_artifacts')
      .select('*')
      .in('attempt_id', attemptIds);
    if (error) throw new Error(`video plaza artifacts read failed: ${error.message}`);
    for (const row of (data ?? []) as VideoArtifactRow[]) result.set(String(row.attempt_id), row);
    return result;
  }

  private async getArtifacts(attemptIds: string[]): Promise<Map<string, ImagePlazaArtifact[]>> {
    const result = new Map<string, ImagePlazaArtifact[]>();
    if (attemptIds.length === 0) return result;
    const { data, error } = await this.plaza
      .from('image_plaza_artifacts')
      .select('*')
      .in('attempt_id', attemptIds)
      .order('position');
    if (error) throw new Error(`image plaza artifacts read failed: ${error.message}`);
    await Promise.all(
      ((data ?? []) as ArtifactRow[]).map(async (row) => {
        const list = result.get(row.attempt_id) ?? [];
        list.push({
          id: row.id,
          image_url: await signPlazaImagePath(row.storage_path),
          width: row.width,
          height: row.height,
        });
        result.set(row.attempt_id, list);
      })
    );
    return result;
  }

  private async findAttemptByIdempotency(
    userId: string,
    key: string,
    body: SubmitImagePlazaAttemptRequest
  ): Promise<ImagePlazaAttempt | null> {
    const { data, error } = await this.plaza
      .from('image_plaza_attempts')
      .select('*')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
      .maybeSingle();
    if (error) throw new Error(`image plaza idempotency read failed: ${error.message}`);
    if (!data) return null;
    const row = data as AttemptRow;
    if (
      row.quote_id !== body.quote_id ||
      row.prompt !== body.prompt ||
      row.model_id !== body.model_id ||
      row.mode !== body.mode ||
      row.aspect_ratio !== body.aspect_ratio ||
      row.resolution !== body.resolution ||
      row.reasoning !== body.reasoning ||
      row.auto_optimize !== body.auto_optimize ||
      row.reference_artifact_id !== (body.reference_artifact_id ?? null)
    ) {
      throw new Error('image_plaza_idempotency_conflict');
    }
    const artifacts = await this.getArtifacts([row.id]);
    return mapAttemptRow(row, artifacts.get(row.id) ?? []);
  }

  /** 公开作品使用过的参考图可被“用同款”复用；其他用户私有上传仍不可访问。 */
  private async canAccessReference(referenceId: string, userId: string): Promise<boolean> {
    const { data: owned, error: ownedError } = await this.plaza
      .from('image_plaza_reference_assets')
      .select('id')
      .eq('id', referenceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (ownedError) throw new Error(`image plaza reference read failed: ${ownedError.message}`);
    if (owned) return true;

    const { data: publicWork, error: workError } = await this.plaza
      .from('image_plaza_works')
      .select('id')
      .contains('snapshot', { reference_artifact_id: referenceId })
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (workError) throw new Error(`image plaza reference access failed: ${workError.message}`);
    return Boolean(publicWork);
  }
}

function mapAttemptRow(row: AttemptRow, artifacts: ImagePlazaArtifact[]): ImagePlazaAttempt {
  const status = row.status === 'leased' || row.status === 'storing' ? 'generating' : row.status;
  if (!['pending', 'generating', 'ready', 'failed', 'failed_unknown'].includes(status)) {
    throw new Error('image_plaza_attempt_status_invalid');
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    status: status as ImagePlazaAttempt['status'],
    quote_credits: Number(row.quote_credits),
    error_code: row.error_code,
    artifacts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function mapVideoConversationAttempt(
  row: VideoConversationAttemptRow,
  artifact: VideoArtifactRow | null
): Promise<VideoPlazaAttempt> {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    status: row.status,
    error_code: row.error_code,
    quote_credits: Number(row.quote_credits),
    params: {
      model_id: row.model_id,
      input_mode: row.input_mode,
      duration_s: row.duration_s,
      resolution: row.resolution,
      aspect_ratio: row.aspect_ratio,
      audio: row.audio,
      reference_artifact_id: row.reference_artifact_id,
    },
    artifact: artifact
      ? {
          id: artifact.id,
          video_url: await signPrivateVideoPath(artifact.storage_path),
          poster_url: artifact.poster_path
            ? await signPrivateVideoPath(artifact.poster_path)
            : null,
          width: artifact.width,
          height: artifact.height,
          duration_ms: artifact.duration_ms,
        }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapConversationRow(
  row: ConversationRow,
  messages: Array<
    MessageRow & {
      attempt?: ImagePlazaAttempt | null;
      videoAttempt?: VideoPlazaAttempt | null;
    }
  >
): ImagePlazaConversation {
  const snapshot =
    row.snapshot === null
      ? null
      : ImagePlazaSnapshotSchema.safeParse(row.snapshot).success
        ? ImagePlazaSnapshotSchema.parse(row.snapshot)
        : VideoPlazaSnapshotSchema.parse(row.snapshot);
  return {
    id: row.id,
    title: row.title,
    snapshot,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      media_type: message.media_type ?? 'image',
      attempt: message.attempt ?? null,
      video_attempt: message.videoAttempt ?? null,
      created_at: message.created_at,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** ILIKE 通配符与 PostgREST 过滤分隔符需转义，避免用户输入扩大或破坏过滤条件。 */
function escapeIlikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** PostgREST `.or()` 值含逗号/点号等时需双引号包裹，并转义内部引号与反斜杠。 */
function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function promptZhTagFilter(labels: string[] | undefined): string | null {
  const terms = [
    ...new Set(
      (labels ?? []).map((label) => escapeIlikePattern(label.trim().slice(0, 80))).filter(Boolean)
    ),
  ];
  if (terms.length === 0) return null;
  return terms
    .map((term) => `snapshot->>prompt_zh.ilike.${quotePostgrestFilterValue(`%${term}%`)}`)
    .join(',');
}

function encodeCursor(likeCount: number, publishedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ likeCount, publishedAt, id })).toString('base64url');
}

function decodeCursor(
  cursor?: string
): { likeCount: number; publishedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.likeCount !== 'number' ||
      !Number.isSafeInteger(record.likeCount) ||
      record.likeCount < 0 ||
      typeof record.publishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(record.publishedAt) ||
      typeof record.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(record.id)
    ) {
      return null;
    }
    return { likeCount: record.likeCount, publishedAt: record.publishedAt, id: record.id };
  } catch {
    return null;
  }
}
