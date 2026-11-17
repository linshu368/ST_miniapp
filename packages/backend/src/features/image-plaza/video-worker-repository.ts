import { getDomainDb } from '../../lib/supabase.js';
import { signPlazaImagePath } from './storage.js';
import type { VideoAttemptRow } from './video-repository.js';

export class VideoPlazaWorkerRepository {
  protected readonly plaza: ReturnType<typeof getDomainDb> = getDomainDb('media_plaza');
  protected readonly billing: ReturnType<typeof getDomainDb> = getDomainDb('billing');
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
    if (error)
      throw new Error(`video_plaza_submit_claim_failed:${error.message}`, { cause: error });
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
    if (error) throw new Error(`video_plaza_poll_claim_failed:${error.message}`, { cause: error });
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
    if (error)
      throw new Error(`video_plaza_queue_update_failed:${error.message}`, { cause: error });
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
    if (error)
      throw new Error(`video_plaza_submit_release_failed:${error.message}`, { cause: error });
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
    if (error) throw new Error(`video_plaza_poll_update_failed:${error.message}`, { cause: error });
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
    if (error)
      throw new Error(`video_plaza_storing_update_failed:${error.message}`, { cause: error });
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
    if (error) throw new Error(`video_plaza_publish_failed:${error.message}`, { cause: error });
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
    if (error)
      throw new Error(`video_plaza_failure_update_failed:${error.message}`, { cause: error });
    if (input.refund) {
      const refund = await this.billing.rpc('refund_media_plaza_video', {
        p_attempt_id: attemptId,
        p_reason: input.code,
      });
      if (refund.error)
        throw new Error(`video_plaza_refund_failed:${refund.error.message}`, {
          cause: refund.error,
        });
    }
  }
}
