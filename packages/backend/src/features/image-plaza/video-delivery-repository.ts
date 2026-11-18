import { getDomainDb } from '../../lib/supabase.js';
import type { VideoAttemptRow } from './video-repository.js';
import type { StreamUploadSession } from './video-stream-upload.js';

export interface DeliveryJob {
  id: string;
  attempt_id: string;
  stage: 'queued' | 'creating' | 'uploading' | 'encoding' | 'completed' | 'failed' | 'unknown';
  stream_uid: string | null;
  upload_url: string | null;
  source_sha256: string | null;
  source_byte_size: number | null;
  lease_token: string;
  retry_count: number;
  deadline_at: string;
  created_at: string;
}

export class VideoDeliveryRepository {
  private readonly db = getDomainDb('media_plaza');

  async claim(): Promise<DeliveryJob[]> {
    const result = await this.db.rpc('claim_video_delivery_jobs', { p_limit: 2 });
    if (result.error) throw new Error('video_delivery_claim_failed', { cause: result.error });
    return (result.data ?? []) as DeliveryJob[];
  }

  async attempt(id: string): Promise<VideoAttemptRow> {
    const result = await this.db.from('video_attempts').select('*').eq('id', id).single();
    if (result.error) throw new Error('video_delivery_attempt_failed', { cause: result.error });
    return result.data as VideoAttemptRow;
  }

  async checkpoint(
    job: DeliveryJob,
    fields: {
      stage?: DeliveryJob['stage'];
      stream_uid?: string;
      upload_url?: string | null;
      source_sha256?: string;
      source_byte_size?: number;
      retry_count?: number;
      next_run_at?: string;
      deadline_at?: string;
      lease_token?: null;
      lease_expires_at?: null;
    }
  ): Promise<void> {
    const result = await this.db
      .from('video_delivery_jobs')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('lease_token', job.lease_token)
      .gt('lease_expires_at', new Date().toISOString())
      .select('id')
      .maybeSingle();
    if (result.error) throw new Error('video_delivery_checkpoint_unknown', { cause: result.error });
    if (!result.data) throw new Error('video_delivery_lease_lost');
  }

  async saveSession(job: DeliveryJob, session: StreamUploadSession) {
    await this.checkpoint(job, {
      stage: 'uploading',
      stream_uid: session.uid,
      upload_url: session.uploadUrl,
      source_byte_size: session.byteSize,
      source_sha256: session.sha256,
    });
  }

  async release(job: DeliveryJob, retry = false, retryAfterMs = 0) {
    const retryCount = retry ? job.retry_count + 1 : 0;
    await this.checkpoint(job, {
      retry_count: retryCount,
      next_run_at: new Date(
        Date.now() + Math.max(retryAfterMs, Math.min(60_000, 5000 * 2 ** Math.min(retryCount, 4)))
      ).toISOString(),
      lease_token: null,
      lease_expires_at: null,
    });
  }

  async fail(job: DeliveryJob, code: string, unknown: boolean) {
    const result = await this.db.rpc('fail_video_delivery', {
      p_attempt_id: job.attempt_id,
      p_lease_token: job.lease_token,
      p_error_code: code,
      p_unknown: unknown,
    });
    if (result.error) throw new Error('video_delivery_failure_unknown', { cause: result.error });
  }

  async publish(
    job: DeliveryJob,
    input: {
      playbackUrl: string;
      width: number;
      height: number;
      durationMs: number;
      posterPath: string;
      posterWidth: number;
      posterHeight: number;
    }
  ) {
    const result = await this.db.rpc('publish_video_artifact', {
      p_attempt_id: job.attempt_id,
      p_lease_token: job.lease_token,
      p_stream_uid: job.stream_uid,
      p_playback_url: input.playbackUrl,
      p_byte_size: job.source_byte_size,
      p_width: input.width,
      p_height: input.height,
      p_duration_ms: input.durationMs,
      p_poster_path: input.posterPath,
      p_poster_width: input.posterWidth,
      p_poster_height: input.posterHeight,
    });
    if (result.error || typeof result.data?.artifact_id !== 'string')
      throw new Error('video_delivery_publish_unknown', { cause: result.error });
    return result.data.artifact_id as string;
  }

  async failedAssets(): Promise<Array<{ id: string; stream_uid: string }>> {
    const result = await this.db
      .from('video_delivery_jobs')
      .select('id,stream_uid')
      .eq('stage', 'failed')
      .not('stream_uid', 'is', null)
      .limit(4);
    if (result.error)
      throw new Error('video_delivery_cleanup_read_failed', { cause: result.error });
    const assets = (result.data ?? []) as Array<{ id: string; stream_uid: string }>;
    if (!assets.length) return assets;
    const referenced = await this.db
      .from('video_artifacts')
      .select('id')
      .in(
        'stream_uid',
        assets.map((asset) => asset.stream_uid)
      )
      .limit(1);
    if (referenced.error || referenced.data?.length)
      throw new Error('video_delivery_cleanup_reference_check_failed', { cause: referenced.error });
    return assets;
  }

  async cleaned(id: string) {
    const result = await this.db
      .from('video_delivery_jobs')
      .update({ stream_uid: null })
      .eq('id', id)
      .eq('stage', 'failed');
    if (result.error)
      throw new Error('video_delivery_cleanup_checkpoint_failed', { cause: result.error });
  }

  async prune() {
    const result = await this.db
      .from('video_delivery_jobs')
      .select('id')
      .in('stage', ['completed', 'failed'])
      .lt('updated_at', new Date(Date.now() - 7 * 86400_000).toISOString())
      .or('stage.eq.completed,stream_uid.is.null')
      .limit(50);
    if (result.error) throw new Error('video_delivery_prune_read_failed', { cause: result.error });
    if (!result.data?.length) return;
    const deleted = await this.db
      .from('video_delivery_jobs')
      .delete()
      .in(
        'id',
        result.data.map((row) => String(row.id))
      );
    if (deleted.error) throw new Error('video_delivery_prune_failed', { cause: deleted.error });
  }
}
