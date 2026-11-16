import { Buffer } from 'node:buffer';
import { getDomainDb } from '../../lib/supabase.js';
import {
  deletePlazaImage,
  downloadPlazaImage,
  uploadPlazaImage,
  type PlazaMimeType,
} from './storage.js';
import {
  ImagePlazaSettlementError,
  ImagePlazaWorkerAttempt,
  canAccessReference,
} from './repository-model.js';

/** Worker persistence keeps the same client handles and settlement ordering. */
export class ImagePlazaWorkerRepository {
  constructor(
    private readonly mediaPlaza: ReturnType<typeof getDomainDb>,
    private readonly billing: ReturnType<typeof getDomainDb>
  ) {}

  async claimJobs(
    workerId: string,
    limit: number,
    leaseSeconds: number
  ): Promise<ImagePlazaWorkerAttempt[]> {
    const { data, error } = await this.mediaPlaza.rpc('claim_image_plaza_jobs', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`image plaza claim failed: ${error.message}`, { cause: error });
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
    const { error } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .update({
        status: 'generating',
        provider_request_id: providerRequestId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId)
      .eq('status', 'leased');
    if (error)
      throw new Error(`image plaza attempt update failed: ${error.message}`, { cause: error });
  }

  async recordProviderRequestId(
    attemptId: string,
    providerRequestId: string | null
  ): Promise<void> {
    if (!providerRequestId) return;
    const { error } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .update({ provider_request_id: providerRequestId.slice(0, 240) })
      .eq('id', attemptId)
      .eq('status', 'generating');
    if (error)
      throw new Error(`image plaza provider request update failed: ${error.message}`, {
        cause: error,
      });
  }

  async markFailed(attemptId: string, code: string, outcomeUnknown: boolean): Promise<void> {
    const { error } = await this.mediaPlaza
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
    if (error)
      throw new Error(`image plaza failure update failed: ${error.message}`, { cause: error });
  }

  async markStaleDispatchedUnknown(olderThanIso: string): Promise<void> {
    const { error } = await this.mediaPlaza
      .from('image_plaza_attempts')
      .update({
        status: 'failed_unknown',
        error_code: 'image_plaza_worker_interrupted',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('status', ['generating', 'storing'])
      .lt('lease_expires_at', olderThanIso);
    if (error)
      throw new Error(`image plaza stale reconciliation failed: ${error.message}`, {
        cause: error,
      });
  }

  async loadReference(
    referenceId: string,
    userId: string
  ): Promise<{ bytes: Buffer; mimeType: PlazaMimeType }> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_reference_assets')
      .select('storage_path,mime_type,user_id')
      .eq('id', referenceId)
      .maybeSingle();
    if (error || !data) throw new Error('image_plaza_reference_not_found');
    if (
      String(data.user_id) !== userId &&
      !(await canAccessReference(this.mediaPlaza, referenceId, userId))
    ) {
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
    await this.mediaPlaza
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
}
