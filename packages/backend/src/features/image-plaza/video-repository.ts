import {
  type ProviderVideoPlazaModel,
  type SubmitVideoPlazaAttemptData,
  type SubmitVideoPlazaAttemptRequest,
  type VideoPlazaAttempt,
  type VideoPlazaInputMode,
  type VideoPlazaQuoteData,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { signPlazaImagePath, signPrivateVideoPath } from './storage.js';

interface VideoQuoteRow {
  id: string;
  user_id: string;
  model_id: string;
  provider_model_id: string;
  input_mode: VideoPlazaInputMode;
  duration_s: number;
  resolution: string;
  aspect_ratio: string | null;
  audio: boolean;
  credits: number;
  expires_at: string;
}

export interface VideoAttemptRow extends VideoQuoteRow {
  conversation_id: string;
  quote_id: string;
  idempotency_key: string;
  prompt: string;
  status: VideoPlazaAttempt['status'];
  error_code: string | null;
  quote_credits: number;
  reference_artifact_id: string | null;
  created_at: string;
  updated_at: string;
  lease_owner: string | null;
  provider_request_id: string | null;
  download_url: string | null;
  next_poll_at: string | null;
  poll_count: number;
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

export class VideoPlazaRepository {
  private readonly plaza = getDomainDb('media_plaza');
  private readonly billing = getDomainDb('billing');

  async createQuote(input: {
    userId: string;
    model: ProviderVideoPlazaModel;
    inputMode: VideoPlazaInputMode;
    duration: number;
    resolution: string;
    aspectRatio: string | null;
    audio: boolean;
    catalogVersion: number;
  }): Promise<VideoPlazaQuoteData> {
    const key = `${input.duration}|${input.resolution}|${input.audio ? 1 : 0}`;
    const credits = input.model.price_matrix[key];
    const providerModelId = input.model.provider_ids[input.inputMode];
    if (!credits || !providerModelId) throw new Error('video_plaza_quote_option_invalid');
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { data, error } = await this.plaza
      .from('video_quotes')
      .insert({
        user_id: input.userId,
        model_id: input.model.id,
        provider_model_id: providerModelId,
        input_mode: input.inputMode,
        duration_s: input.duration,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        audio: input.audio,
        credits,
        catalog_version: input.catalogVersion,
        expires_at: expiresAt,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`video_plaza_quote_create_failed:${error?.message ?? ''}`);
    return {
      quote_id: String(data.id),
      model_id: input.model.id,
      input_mode: input.inputMode,
      duration_s: input.duration,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      audio: input.audio,
      credits,
      expires_at: expiresAt,
    };
  }

  async createAttempt(input: {
    userId: string;
    conversationId: string;
    body: SubmitVideoPlazaAttemptRequest;
  }): Promise<SubmitVideoPlazaAttemptData> {
    const existing = await this.findByIdempotency(input.userId, input.body);
    if (existing) return { attempt: existing };

    const [{ data: conversation }, { data: quote }] = await Promise.all([
      this.plaza
        .from('image_plaza_conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', input.userId)
        .maybeSingle(),
      this.plaza
        .from('video_quotes')
        .select('*')
        .eq('id', input.body.quote_id)
        .eq('user_id', input.userId)
        .maybeSingle(),
    ]);
    if (!conversation) throw new Error('image_plaza_conversation_not_found');
    if (!quote) throw new Error('video_plaza_quote_not_found');
    const quoteRow = quote as VideoQuoteRow;
    if (Date.parse(quoteRow.expires_at) <= Date.now()) throw new Error('video_plaza_quote_expired');
    const referenceId = input.body.reference_artifact_id ?? null;
    if ((quoteRow.input_mode === 't2v') !== (referenceId === null))
      throw new Error('video_plaza_reference_mode_mismatch');
    if (quoteRow.input_mode !== 't2v' && !referenceId)
      throw new Error('video_plaza_reference_required');
    if (referenceId && !(await this.canAccessReference(referenceId, input.userId)))
      throw new Error('video_plaza_reference_not_found');

    const { data: userMessage, error: userError } = await this.plaza
      .from('image_plaza_messages')
      .insert({
        conversation_id: input.conversationId,
        role: 'user',
        content: input.body.prompt,
        media_type: 'image',
      })
      .select('id,created_at')
      .single();
    if (userError || !userMessage) throw new Error('video_plaza_message_create_failed');
    const { data: assistantMessage, error: assistantError } = await this.plaza
      .from('image_plaza_messages')
      .insert({
        conversation_id: input.conversationId,
        role: 'assistant',
        content: '视频生成排队中',
        media_type: 'image',
      })
      .select('id,created_at')
      .single();
    if (assistantError || !assistantMessage) {
      await this.plaza.from('image_plaza_messages').delete().eq('id', userMessage.id);
      throw new Error('video_plaza_message_create_failed');
    }

    const { data, error } = await this.plaza
      .from('video_attempts')
      .insert({
        user_id: input.userId,
        conversation_id: input.conversationId,
        user_message_id: userMessage.id,
        assistant_message_id: assistantMessage.id,
        quote_id: quoteRow.id,
        idempotency_key: input.body.idempotency_key,
        prompt: input.body.prompt,
        model_id: quoteRow.model_id,
        provider_model_id: quoteRow.provider_model_id,
        input_mode: quoteRow.input_mode,
        duration_s: quoteRow.duration_s,
        resolution: quoteRow.resolution,
        aspect_ratio: quoteRow.aspect_ratio,
        audio: quoteRow.audio,
        reference_artifact_id: referenceId,
        quote_credits: quoteRow.credits,
      })
      .select('*')
      .single();
    if (error || !data) {
      const replay = await this.findByIdempotency(input.userId, input.body);
      await this.plaza
        .from('image_plaza_messages')
        .delete()
        .in('id', [userMessage.id, assistantMessage.id]);
      if (replay) return { attempt: replay };
      throw new Error(`video_plaza_attempt_create_failed:${error?.message ?? ''}`);
    }

    await this.plaza
      .from('image_plaza_messages')
      .update({ media_type: 'video', video_attempt_id: data.id })
      .in('id', [userMessage.id, assistantMessage.id]);
    const reserve = await this.billing.rpc('reserve_media_plaza_video', {
      p_attempt_id: data.id,
      p_user_id: input.userId,
    });
    if (reserve.error) throw new Error(`video_plaza_reserve_failed:${reserve.error.message}`);
    if (reserve.data?.status === 'insufficient_balance')
      throw new Error('video_plaza_insufficient_balance');
    if (reserve.data?.status === 'too_many_active') throw new Error('video_plaza_too_many_active');
    const attempt = await this.getAttempt(String(data.id), input.userId);
    if (!attempt) throw new Error('video_plaza_attempt_not_found');
    return {
      attempt,
      message_refs: {
        user: { id: String(userMessage.id), created_at: String(userMessage.created_at) },
        assistant: {
          id: String(assistantMessage.id),
          created_at: String(assistantMessage.created_at),
        },
      },
    };
  }

  async getAttempt(attemptId: string, userId: string): Promise<VideoPlazaAttempt | null> {
    const [attemptResult, artifactResult] = await Promise.all([
      this.plaza
        .from('video_attempts')
        .select('*')
        .eq('id', attemptId)
        .eq('user_id', userId)
        .maybeSingle(),
      this.plaza.from('video_artifacts').select('*').eq('attempt_id', attemptId).maybeSingle(),
    ]);
    const { data, error } = attemptResult;
    if (error) throw new Error(`video_plaza_attempt_read_failed:${error.message}`);
    if (!data) return null;
    const { data: artifact, error: artifactError } = artifactResult;
    if (artifactError) throw new Error(`video_plaza_artifact_read_failed:${artifactError.message}`);
    return this.mapAttempt(data as VideoAttemptRow, artifact as VideoArtifactRow | null);
  }

  async claimSubmitJobs(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<VideoAttemptRow[]> {
    const { data, error } = await this.plaza.rpc('claim_video_submit_jobs', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`video_plaza_submit_claim_failed:${error.message}`);
    return (data ?? []) as VideoAttemptRow[];
  }

  async claimPollJobs(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<VideoAttemptRow[]> {
    const { data, error } = await this.plaza.rpc('claim_video_poll_jobs', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`video_plaza_poll_claim_failed:${error.message}`);
    return (data ?? []) as VideoAttemptRow[];
  }

  async getReferenceUrl(referenceId: string | null): Promise<string | null> {
    if (!referenceId) return null;
    const { data, error } = await this.plaza
      .from('image_plaza_reference_assets')
      .select('storage_path')
      .eq('id', referenceId)
      .maybeSingle();
    if (error || !data?.storage_path) throw new Error('video_plaza_reference_not_found');
    return signPlazaImagePath(String(data.storage_path), 15 * 60);
  }

  async markQueued(
    attemptId: string,
    workerId: string,
    queueId: string,
    downloadUrl: string | null
  ): Promise<void> {
    const { error } = await this.plaza
      .from('video_attempts')
      .update({
        status: 'queued',
        provider_request_id: queueId,
        download_url: downloadUrl,
        next_poll_at: new Date(Date.now() + 5_000).toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('lease_owner', workerId)
      .eq('status', 'submitting');
    if (error) throw new Error(`video_plaza_queue_update_failed:${error.message}`);
  }

  async releaseSubmit(attemptId: string, workerId: string, retryCount: number): Promise<void> {
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(retryCount, 4));
    const { error } = await this.plaza
      .from('video_attempts')
      .update({
        lease_owner: null,
        lease_expires_at: new Date(Date.now() + delay).toISOString(),
        poll_count: retryCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('lease_owner', workerId)
      .eq('status', 'submitting');
    if (error) throw new Error(`video_plaza_submit_release_failed:${error.message}`);
  }

  async schedulePoll(
    attemptId: string,
    workerId: string,
    status: 'queued' | 'processing',
    pollCount: number,
    recommendedDelayMs?: number
  ): Promise<void> {
    const delay =
      recommendedDelayMs === undefined
        ? Math.min(60_000, 5_000 * 2 ** Math.min(pollCount, 4))
        : Math.min(60_000, Math.max(5_000, Math.round(recommendedDelayMs)));
    const { error } = await this.plaza
      .from('video_attempts')
      .update({
        status,
        poll_count: pollCount,
        next_poll_at: new Date(Date.now() + delay).toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('lease_owner', workerId)
      .in('status', ['queued', 'processing']);
    if (error) throw new Error(`video_plaza_poll_update_failed:${error.message}`);
  }

  async markStoring(
    attemptId: string,
    workerId: string,
    downloadUrl: string | null
  ): Promise<void> {
    const { error } = await this.plaza
      .from('video_attempts')
      .update({
        status: 'storing',
        download_url: downloadUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('lease_owner', workerId)
      .in('status', ['queued', 'processing']);
    if (error) throw new Error(`video_plaza_storing_update_failed:${error.message}`);
  }

  async publish(input: {
    attemptId: string;
    workerId: string;
    storagePath: string;
    byteSize: number;
    width: number;
    height: number;
    durationMs: number;
    posterPath: string;
    posterWidth: number;
    posterHeight: number;
  }): Promise<void> {
    const { error } = await this.plaza.rpc('publish_video_artifact', {
      p_attempt_id: input.attemptId,
      p_worker_id: input.workerId,
      p_storage_path: input.storagePath,
      p_byte_size: input.byteSize,
      p_width: input.width,
      p_height: input.height,
      p_duration_ms: input.durationMs,
      p_poster_path: input.posterPath,
      p_poster_width: input.posterWidth,
      p_poster_height: input.posterHeight,
    });
    if (error) throw new Error(`video_plaza_publish_failed:${error.message}`);
  }

  async fail(
    attemptId: string,
    workerId: string,
    input: {
      status: 'failed' | 'moderation_rejected' | 'expired' | 'failed_unknown';
      code: string;
      refund: boolean;
    }
  ): Promise<void> {
    const { error } = await this.plaza
      .from('video_attempts')
      .update({
        status: input.status,
        error_code: input.code,
        download_url: null,
        lease_owner: null,
        lease_expires_at: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('lease_owner', workerId)
      .in('status', ['submitting', 'queued', 'processing', 'storing']);
    if (error) throw new Error(`video_plaza_failure_update_failed:${error.message}`);
    if (input.refund) {
      const refund = await this.billing.rpc('refund_media_plaza_video', {
        p_attempt_id: attemptId,
        p_reason: input.code,
      });
      if (refund.error) throw new Error(`video_plaza_refund_failed:${refund.error.message}`);
    }
  }

  async share(input: {
    userId: string;
    artifactId: string;
    title: string;
    description: string;
    modelName: string;
    tags: string[];
    rebateRate: number;
  }): Promise<{ workId: string; alreadyShared: boolean; rewardCredits: number }> {
    const { data, error } = await this.billing.rpc('share_media_plaza_video', {
      p_user_id: input.userId,
      p_artifact_id: input.artifactId,
      p_title: input.title,
      p_description: input.description,
      p_model_name: input.modelName,
      p_tags: input.tags,
      p_rebate_rate: input.rebateRate,
    });
    if (error || !data || typeof data.work_id !== 'string')
      throw new Error(`video_plaza_share_failed:${error?.message ?? 'invalid result'}`);
    return {
      workId: data.work_id,
      alreadyShared: data.already_shared === true,
      rewardCredits: Number(data.reward_credits ?? 0),
    };
  }

  async getArtifactModelId(artifactId: string, userId: string): Promise<string> {
    const { data: artifact, error } = await this.plaza
      .from('video_artifacts')
      .select('attempt_id')
      .eq('id', artifactId)
      .maybeSingle();
    if (error || !artifact?.attempt_id) throw new Error('video_plaza_artifact_not_found');
    const { data: attempt, error: attemptError } = await this.plaza
      .from('video_attempts')
      .select('model_id')
      .eq('id', artifact.attempt_id)
      .eq('user_id', userId)
      .eq('status', 'ready')
      .maybeSingle();
    if (attemptError || !attempt?.model_id) throw new Error('video_plaza_artifact_not_found');
    return String(attempt.model_id);
  }

  private async findByIdempotency(
    userId: string,
    body: SubmitVideoPlazaAttemptRequest
  ): Promise<VideoPlazaAttempt | null> {
    const { data, error } = await this.plaza
      .from('video_attempts')
      .select('*')
      .eq('user_id', userId)
      .eq('idempotency_key', body.idempotency_key)
      .maybeSingle();
    if (error) throw new Error(`video_plaza_idempotency_read_failed:${error.message}`);
    if (!data) return null;
    const row = data as VideoAttemptRow;
    if (
      row.quote_id !== body.quote_id ||
      row.prompt !== body.prompt ||
      row.reference_artifact_id !== (body.reference_artifact_id ?? null)
    ) {
      throw new Error('video_plaza_idempotency_conflict');
    }
    return this.getAttempt(row.id, userId);
  }

  private async canAccessReference(referenceId: string, userId: string): Promise<boolean> {
    const { data: owned, error: ownedError } = await this.plaza
      .from('image_plaza_reference_assets')
      .select('id')
      .eq('id', referenceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (ownedError) throw new Error('video_plaza_reference_read_failed');
    if (owned) return true;
    const { data: publicWork, error: publicError } = await this.plaza
      .from('image_plaza_works')
      .select('id')
      .contains('snapshot', { reference_artifact_id: referenceId })
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (publicError) throw new Error('video_plaza_reference_read_failed');
    return Boolean(publicWork);
  }

  private async mapAttempt(
    row: VideoAttemptRow,
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
}
