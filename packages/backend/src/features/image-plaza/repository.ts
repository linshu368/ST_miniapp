import { Buffer } from 'node:buffer';
import {
  ImagePlazaSnapshotSchema,
  type ImagePlazaArtifact,
  type ImagePlazaAttempt,
  type ImagePlazaConversation,
  type ImagePlazaSnapshot,
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
import {
  ImagePlazaWorkerAttempt,
  ArtifactRow,
  AttemptRow,
  MessageRow,
  ConversationRow,
  mapAttemptRow,
  mapConversationRow,
  canAccessReference,
} from './repository-model.js';
import { ImagePlazaFeedRepository } from './repository-feed.js';
import { ImagePlazaWorkerRepository } from './repository-worker.js';

export { ImagePlazaSettlementError } from './repository-model.js';

export type { ImagePlazaWorkerAttempt } from './repository-model.js';

/** Public repository API remains stable while feed and worker storage stay focused. */
export class ImagePlazaRepository extends ImagePlazaFeedRepository {
  private readonly billing = getDomainDb('billing');

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
    const { data, error } = await this.mediaPlaza
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
    if (error || !data)
      throw new Error(`image plaza quote create failed: ${error?.message}`, { cause: error });
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
    const { data, error } = await this.mediaPlaza
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
      throw new Error(`image plaza reference create failed: ${error?.message}`, { cause: error });
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
      const { data, error } = await this.mediaPlaza
        .from('image_plaza_works')
        .select('title,snapshot')
        .eq('id', sourceWorkId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error || !data) throw new Error('image_plaza_source_work_not_found');
      const parsed = ImagePlazaSnapshotSchema.safeParse(data.snapshot);
      if (!parsed.success) throw new Error('image_plaza_source_snapshot_invalid');
      title = `同款 · ${String(data.title).slice(0, 68)}`;
      // 同款会话只保留英文 prompt；中文译文仅用于作品详情展示与列表搜索。
      const { prompt_zh: _promptZh, ...useSameSnapshot } = parsed.data;
      snapshot = useSameSnapshot;
    }
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_conversations')
      .insert({ user_id: userId, title, source_work_id: sourceWorkId ?? null, snapshot })
      .select('*')
      .single();
    if (error || !data)
      throw new Error(`image plaza conversation create failed: ${error?.message}`, {
        cause: error,
      });
    // 新建会话必然没有消息和任务，直接映射可省掉两次空表读取，缩短“用同款”跳转等待。
    return mapConversationRow(data as ConversationRow, []);
  }

  async listConversations(
    userId: string
  ): Promise<Array<Omit<ImagePlazaConversation, 'messages'>>> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error)
      throw new Error(`image plaza conversations read failed: ${error.message}`, { cause: error });
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
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error)
      throw new Error(`image plaza conversation read failed: ${error.message}`, { cause: error });
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
      this.mediaPlaza
        .from('image_plaza_conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', input.userId)
        .maybeSingle(),
      this.mediaPlaza
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
      if (
        !(await canAccessReference(this.mediaPlaza, input.body.reference_artifact_id, input.userId))
      ) {
        throw new Error('image_plaza_reference_not_found');
      }
    }
    if ((input.body.mode !== 't2i') !== Boolean(input.body.reference_artifact_id)) {
      throw new Error('image_plaza_reference_mode_mismatch');
    }
    const { data: userMessage, error: userError } = await this.mediaPlaza
      .from('image_plaza_messages')
      .insert({ conversation_id: input.conversationId, role: 'user', content: input.body.prompt })
      .select('id')
      .single();
    if (userError || !userMessage)
      throw new Error(`image plaza message create failed: ${userError?.message}`, {
        cause: userError,
      });
    const { data: assistantMessage, error: assistantError } = await this.mediaPlaza
      .from('image_plaza_messages')
      .insert({ conversation_id: input.conversationId, role: 'assistant', content: '生成中' })
      .select('id')
      .single();
    if (assistantError || !assistantMessage) {
      await this.mediaPlaza.from('image_plaza_messages').delete().eq('id', userMessage.id);
      throw new Error(`image plaza placeholder create failed: ${assistantError?.message}`, {
        cause: assistantError,
      });
    }
    const { data: attempt, error: attemptError } = await this.mediaPlaza
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
      await this.mediaPlaza
        .from('image_plaza_messages')
        .delete()
        .in('id', [userMessage.id, assistantMessage.id]);
      const raced = await this.findAttemptByIdempotency(
        input.userId,
        input.body.idempotency_key,
        input.body
      );
      if (raced) return raced;
      throw new Error(`image plaza attempt create failed: ${attemptError?.message}`, {
        cause: attemptError,
      });
    }
    await this.mediaPlaza
      .from('image_plaza_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', input.conversationId);
    return mapAttemptRow(attempt as AttemptRow, []);
  }

  async getAttempt(attemptId: string, userId: string): Promise<ImagePlazaAttempt | null> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .select('*')
      .eq('id', attemptId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error)
      throw new Error(`image plaza attempt read failed: ${error.message}`, { cause: error });
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
    if (error) throw new Error(`image plaza share failed: ${error.message}`, { cause: error });
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

  private async hydrateConversation(row: ConversationRow): Promise<ImagePlazaConversation> {
    const [{ data: messages, error: messageError }, { data: attempts, error: attemptError }] =
      await Promise.all([
        this.mediaPlaza
          .from('image_plaza_messages')
          .select('*')
          .eq('conversation_id', row.id)
          .order('created_at'),
        this.mediaPlaza.from('image_plaza_attempts').select('*').eq('conversation_id', row.id),
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
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_artifacts')
      .select('*')
      .in('attempt_id', attemptIds)
      .order('position');
    if (error)
      throw new Error(`image plaza artifacts read failed: ${error.message}`, { cause: error });
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
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .select('*')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
      .maybeSingle();
    if (error)
      throw new Error(`image plaza idempotency read failed: ${error.message}`, { cause: error });
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
  private readonly worker = new ImagePlazaWorkerRepository(this.mediaPlaza, this.billing);
  async claimJobs(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<ImagePlazaWorkerAttempt[]> {
    return this.worker.claimJobs(workerId, limit, leaseSeconds);
  }
  async markGenerating(attemptId: string, providerRequestId?: string | null): Promise<void> {
    return this.worker.markGenerating(attemptId, providerRequestId);
  }
  async recordProviderRequestId(
    attemptId: string,
    providerRequestId: string | null
  ): Promise<void> {
    return this.worker.recordProviderRequestId(attemptId, providerRequestId);
  }
  async markFailed(attemptId: string, code: string, outcomeUnknown: boolean): Promise<void> {
    return this.worker.markFailed(attemptId, code, outcomeUnknown);
  }
  async markStaleDispatchedUnknown(olderThanIso: string): Promise<void> {
    return this.worker.markStaleDispatchedUnknown(olderThanIso);
  }
  async loadReference(
    referenceId: string,
    userId: string
  ): Promise<{ bytes: Buffer; mimeType: PlazaMimeType }> {
    return this.worker.loadReference(referenceId, userId);
  }
  async settleGeneratedImage(input: {
    attempt: ImagePlazaWorkerAttempt;
    bytes: Buffer;
    mimeType: PlazaMimeType;
  }): Promise<void> {
    return this.worker.settleGeneratedImage(input);
  }
}
