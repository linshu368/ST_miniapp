import { Buffer } from 'node:buffer';
import {
  ImagePlazaSnapshotSchema,
  type ImagePlazaArtifact,
  type ImagePlazaAttempt,
  type ImagePlazaConversation,
  type ImagePlazaSnapshot,
  type ImagePlazaWork,
  type ProviderImagePlazaModel,
  type SubmitImagePlazaAttemptRequest,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import {
  deletePlazaImage,
  signPlazaImagePath,
  uploadPlazaImage,
  type PlazaMimeType,
} from './storage.js';

interface WorkRow {
  id: string;
  user_id: string;
  attempt_id: string;
  artifact_id: string;
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
}

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
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
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
  private readonly experience = getDomainDb('experience');
  private readonly features = getDomainDb('miniapp_features');
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
    tag?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ works: ImagePlazaWork[]; nextCursor: string | null }> {
    let query = this.experience
      .from('image_plaza_works')
      .select('*')
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(input.limit + 1);
    if (input.search) query = query.ilike('title', `%${input.search.slice(0, 80)}%`);
    if (input.tag) query = query.contains('tags', [input.tag]);
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      query = query.or(
        `published_at.lt.${cursor.publishedAt},and(published_at.eq.${cursor.publishedAt},id.lt.${cursor.id})`
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`image plaza feed read failed: ${error.message}`);
    const rows = (data ?? []) as WorkRow[];
    const visible = rows.slice(0, input.limit);
    const works = await this.hydrateWorks(visible, input.userId);
    const last = visible.at(-1);
    return {
      works,
      nextCursor:
        rows.length > input.limit && last ? encodeCursor(last.published_at, last.id) : null,
    };
  }

  async getWork(workId: string, userId: string): Promise<ImagePlazaWork | null> {
    const { data, error } = await this.experience
      .from('image_plaza_works')
      .select('*')
      .eq('id', workId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(`image plaza work read failed: ${error.message}`);
    if (!data) return null;
    return (await this.hydrateWorks([data as WorkRow], userId))[0] ?? null;
  }

  async setLike(
    userId: string,
    workId: string,
    liked: boolean
  ): Promise<{ liked: boolean; likeCount: number }> {
    const { data: work, error: workError } = await this.experience
      .from('image_plaza_works')
      .select('id,like_count')
      .eq('id', workId)
      .is('deleted_at', null)
      .maybeSingle();
    if (workError || !work) throw new Error('image_plaza_work_not_found');

    if (liked) {
      const { error } = await this.features
        .from('image_plaza_likes')
        .upsert(
          { user_id: userId, work_id: workId },
          { onConflict: 'user_id,work_id', ignoreDuplicates: true }
        );
      if (error) throw new Error(`image plaza like failed: ${error.message}`);
    } else {
      const { error } = await this.features
        .from('image_plaza_likes')
        .delete()
        .eq('user_id', userId)
        .eq('work_id', workId);
      if (error) throw new Error(`image plaza unlike failed: ${error.message}`);
    }
    const { count, error: countError } = await this.features
      .from('image_plaza_likes')
      .select('work_id', { count: 'exact', head: true })
      .eq('work_id', workId);
    if (countError) throw new Error(`image plaza like count failed: ${countError.message}`);
    const likeCount = count ?? 0;
    await this.experience
      .from('image_plaza_works')
      .update({ like_count: likeCount })
      .eq('id', workId);
    return { liked, likeCount };
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
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const { data, error } = await this.experience
      .from('image_plaza_quotes')
      .insert({
        user_id: input.userId,
        model_id: input.model.id,
        provider_model_id: input.model.provider_model_id,
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
    const { data, error } = await this.experience
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
    let title = '新建图片创作';
    let snapshot: ImagePlazaSnapshot | null = null;
    if (sourceWorkId) {
      const { data, error } = await this.experience
        .from('image_plaza_works')
        .select('title,snapshot')
        .eq('id', sourceWorkId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error || !data) throw new Error('image_plaza_source_work_not_found');
      const parsed = ImagePlazaSnapshotSchema.safeParse(data.snapshot);
      if (!parsed.success) throw new Error('image_plaza_source_snapshot_invalid');
      title = `同款 · ${String(data.title).slice(0, 68)}`;
      snapshot = parsed.data;
    }
    const { data, error } = await this.experience
      .from('image_plaza_conversations')
      .insert({ user_id: userId, title, source_work_id: sourceWorkId ?? null, snapshot })
      .select('*')
      .single();
    if (error || !data)
      throw new Error(`image plaza conversation create failed: ${error?.message}`);
    return this.hydrateConversation(data as ConversationRow);
  }

  async listConversations(
    userId: string
  ): Promise<Array<Omit<ImagePlazaConversation, 'messages'>>> {
    const { data, error } = await this.experience
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
    const { data, error } = await this.experience
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
    const existing = await this.findAttemptByIdempotency(input.userId, input.body.idempotency_key);
    if (existing) return existing;
    const [{ data: conversation }, { data: quote }, wallet] = await Promise.all([
      this.experience
        .from('image_plaza_conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', input.userId)
        .maybeSingle(),
      this.experience
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
      const { data: reference } = await this.experience
        .from('image_plaza_reference_assets')
        .select('id')
        .eq('id', input.body.reference_artifact_id)
        .eq('user_id', input.userId)
        .maybeSingle();
      if (!reference) throw new Error('image_plaza_reference_not_found');
    }
    if ((input.body.mode !== 't2i') !== Boolean(input.body.reference_artifact_id)) {
      throw new Error('image_plaza_reference_mode_mismatch');
    }
    const { data: userMessage, error: userError } = await this.experience
      .from('image_plaza_messages')
      .insert({ conversation_id: input.conversationId, role: 'user', content: input.body.prompt })
      .select('id')
      .single();
    if (userError || !userMessage)
      throw new Error(`image plaza message create failed: ${userError?.message}`);
    const { data: assistantMessage, error: assistantError } = await this.experience
      .from('image_plaza_messages')
      .insert({ conversation_id: input.conversationId, role: 'assistant', content: '生成中' })
      .select('id')
      .single();
    if (assistantError || !assistantMessage) {
      await this.experience.from('image_plaza_messages').delete().eq('id', userMessage.id);
      throw new Error(`image plaza placeholder create failed: ${assistantError?.message}`);
    }
    const { data: attempt, error: attemptError } = await this.experience
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
        provider_model_id: input.model.provider_model_id,
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
      await this.experience
        .from('image_plaza_messages')
        .delete()
        .in('id', [userMessage.id, assistantMessage.id]);
      const raced = await this.findAttemptByIdempotency(input.userId, input.body.idempotency_key);
      if (raced) return raced;
      throw new Error(`image plaza attempt create failed: ${attemptError?.message}`);
    }
    await this.experience
      .from('image_plaza_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', input.conversationId);
    return mapAttemptRow(attempt as AttemptRow, []);
  }

  async getAttempt(attemptId: string, userId: string): Promise<ImagePlazaAttempt | null> {
    const { data, error } = await this.experience
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

  private async hydrateWorks(rows: WorkRow[], userId: string): Promise<ImagePlazaWork[]> {
    if (rows.length === 0) return [];
    const artifactIds = rows.map((row) => row.artifact_id);
    const workIds = rows.map((row) => row.id);
    const [{ data: artifactData, error: artifactError }, { data: likeData, error: likeError }] =
      await Promise.all([
        this.experience.from('image_plaza_artifacts').select('*').in('id', artifactIds),
        this.features
          .from('image_plaza_likes')
          .select('work_id')
          .eq('user_id', userId)
          .in('work_id', workIds),
      ]);
    if (artifactError || likeError) throw new Error('image_plaza_work_hydration_failed');
    const artifacts = new Map(
      (artifactData ?? []).map((row) => [String(row.id), row as ArtifactRow])
    );
    const liked = new Set((likeData ?? []).map((row) => String(row.work_id)));
    return Promise.all(
      rows.map(async (row) => {
        const artifact = artifacts.get(row.artifact_id);
        const snapshot = ImagePlazaSnapshotSchema.safeParse(row.snapshot);
        if (!artifact || !snapshot.success) throw new Error('image_plaza_work_shape_invalid');
        let referenceImageUrl: string | null = null;
        if (snapshot.data.reference_artifact_id) {
          const { data: reference } = await this.experience
            .from('image_plaza_reference_assets')
            .select('storage_path')
            .eq('id', snapshot.data.reference_artifact_id)
            .maybeSingle();
          if (reference?.storage_path)
            referenceImageUrl = await signPlazaImagePath(String(reference.storage_path));
        }
        return {
          id: row.id,
          title: row.title,
          image_url: await signPlazaImagePath(artifact.storage_path),
          reference_image_url: referenceImageUrl,
          model_id: row.model_id,
          model_name: row.model_name,
          width: row.width,
          height: row.height,
          tags: row.tags,
          like_count: row.like_count,
          liked: liked.has(row.id),
          published_at: row.published_at,
          snapshot: snapshot.data,
        };
      })
    );
  }

  private async hydrateConversation(row: ConversationRow): Promise<ImagePlazaConversation> {
    const [{ data: messages, error: messageError }, { data: attempts, error: attemptError }] =
      await Promise.all([
        this.experience
          .from('image_plaza_messages')
          .select('*')
          .eq('conversation_id', row.id)
          .order('created_at'),
        this.experience.from('image_plaza_attempts').select('*').eq('conversation_id', row.id),
      ]);
    if (messageError || attemptError) throw new Error('image_plaza_conversation_hydration_failed');
    const attemptRows = (attempts ?? []) as AttemptRow[];
    const artifacts = await this.getArtifacts(attemptRows.map((attempt) => attempt.id));
    const byAssistantMessage = new Map(
      attemptRows.map((attempt) => [
        attempt.assistant_message_id,
        mapAttemptRow(attempt, artifacts.get(attempt.id) ?? []),
      ])
    );
    return mapConversationRow(
      row,
      ((messages ?? []) as MessageRow[]).map((message) => ({
        ...message,
        attempt: byAssistantMessage.get(message.id) ?? null,
      }))
    );
  }

  private async getArtifacts(attemptIds: string[]): Promise<Map<string, ImagePlazaArtifact[]>> {
    const result = new Map<string, ImagePlazaArtifact[]>();
    if (attemptIds.length === 0) return result;
    const { data, error } = await this.experience
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
    key: string
  ): Promise<ImagePlazaAttempt | null> {
    const { data } = await this.experience
      .from('image_plaza_attempts')
      .select('*')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
      .maybeSingle();
    return data ? mapAttemptRow(data as AttemptRow, []) : null;
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

function mapConversationRow(
  row: ConversationRow,
  messages: Array<MessageRow & { attempt?: ImagePlazaAttempt | null }>
): ImagePlazaConversation {
  const snapshot = row.snapshot === null ? null : ImagePlazaSnapshotSchema.parse(row.snapshot);
  return {
    id: row.id,
    title: row.title,
    snapshot,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attempt: message.attempt ?? null,
      created_at: message.created_at,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function encodeCursor(publishedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ publishedAt, id })).toString('base64url');
}

function decodeCursor(cursor?: string): { publishedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.publishedAt !== 'string' || typeof record.id !== 'string') return null;
    return { publishedAt: record.publishedAt, id: record.id };
  } catch {
    return null;
  }
}
