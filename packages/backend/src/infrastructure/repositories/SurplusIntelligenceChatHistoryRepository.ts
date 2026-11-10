import { getDomainDb, type DomainDb } from '../../lib/supabase.js';

export type SurplusCallStatus =
  | 'prepared'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';
export type SurplusRequestRecordStatus =
  | 'pending'
  | 'complete'
  | 'unavailable'
  | 'forbidden'
  | 'not_found';

/** Provider observations never carry the conversation or decide its billing outcome. */
export interface SurplusObservationPatch {
  generation_id?: string | null;
  request_id?: string | null;
  model?: string | null;
  provider_name?: string | null;
  http_status?: number | null;
  call_status?: SurplusCallStatus;
  finish_reason?: string | null;
  error_code?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
  buyer_cost_micro?: string | null;
  usage_usd?: string | null;
  latency_ms?: number | null;
  generation_time_ms?: number | null;
  response_metadata?: Record<string, unknown>;
  metadata_capture_status?: 'complete' | 'partial' | 'unavailable';
  request_record_status?: SurplusRequestRecordStatus;
}

export interface SurplusRecoveryCandidate {
  chat_history_id: string;
  request_id: string;
  generation_id: string | null;
  call_status: SurplusCallStatus;
  request_record_attempts: number;
  request_record_next_retry_at: string | null;
}

const TABLE = 'surplusintelligence_chat_history';
const OPERATION_TIMEOUT_MS = 5_000;
const WRITE_BUDGET_MS = 10_000;
const REQUEST_LIMIT_BYTES = 16 * 1024;
const RESPONSE_LIMIT_BYTES = 128 * 1024;
const RECOVERY_COLUMNS =
  'chat_history_id,request_id,generation_id,call_status,request_record_attempts,request_record_next_retry_at';

function assertIdentity(value: string): void {
  if (!/^[a-zA-Z0-9_.:-]{1,512}$/.test(value)) throw new Error('Surplus 调用身份格式非法');
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return ['PT409', '22023', '23503', '23514'].includes(String(code));
}

function jsonBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  );
}

/** Dedicated one-to-one call evidence; request and terminal merges are atomic database RPCs. */
export class SurplusIntelligenceChatHistoryRepository {
  constructor(private readonly db: DomainDb = getDomainDb('experience')) {}

  async prepare(input: {
    historyId: string;
    attemptId?: string | null;
    requestParameters: Record<string, unknown>;
  }): Promise<void> {
    if (jsonBytes(input.requestParameters) > REQUEST_LIMIT_BYTES)
      throw new Error('Surplus 请求参数超过容量');
    // Fail closed if a caller accidentally passes the full inference body to this boundary.
    if (
      ['messages', 'prompt', 'input', 'content', 'api_key', 'authorization'].some((key) =>
        Object.hasOwn(input.requestParameters, key)
      )
    )
      throw new Error('Surplus 请求参数包含禁止保存的字段');

    const deadline = AbortSignal.timeout(WRITE_BUDGET_MS);
    for (let attempt = 0; attempt < 2; attempt++) {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
      let error: unknown;
      try {
        const result = await this.db
          .rpc('prepare_surplusintelligence_call', {
            p_history_id: input.historyId,
            p_attempt_id: input.attemptId ?? null,
            p_request_parameters: input.requestParameters,
          })
          .abortSignal(signal);
        if (!result.error) return;
        error = result.error;
      } catch (err) {
        error = err;
      }
      if (isConflict(error)) throw new Error('Surplus 请求身份或参数冲突', { cause: error });
      // The RPC may have committed before a transport failure. Confirm before repeating it.
      const read = await this.db
        .from(TABLE)
        .select('attempt_id,request_parameters')
        .eq('chat_history_id', input.historyId)
        .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]))
        .maybeSingle();
      if (!read.error && read.data?.request_parameters !== null && read.data) {
        if (
          sameJson(read.data.request_parameters, input.requestParameters) &&
          read.data.attempt_id === (input.attemptId ?? null)
        )
          return;
        throw new Error('Surplus 请求身份或参数冲突');
      }
      if (attempt === 1 || deadline.aborted)
        throw new Error('保存 Surplus 请求参数未确认', { cause: error ?? read.error });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async ensureGenerationId(historyId: string, generationId: string): Promise<void> {
    assertIdentity(generationId);
    const deadline = AbortSignal.timeout(WRITE_BUDGET_MS);
    for (let attempt = 0; attempt < 2; attempt++) {
      let error: unknown;
      try {
        const result = await this.db
          .rpc('record_surplusintelligence_call', {
            p_history_id: historyId,
            p_patch: { generation_id: generationId },
          })
          .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]));
        if (!result.error) return;
        error = result.error;
      } catch (err) {
        error = err;
      }
      if (isConflict(error)) throw new Error('Surplus 调用 ID 冲突', { cause: error });
      const read = await this.db
        .from(TABLE)
        .select('generation_id')
        .eq('chat_history_id', historyId)
        .abortSignal(AbortSignal.any([deadline, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]))
        .maybeSingle();
      if (!read.error && read.data?.generation_id === generationId) return;
      if (!read.error && read.data?.generation_id) throw new Error('Surplus 调用 ID 冲突');
      if (attempt === 1 || deadline.aborted)
        throw new Error('保存 Surplus 调用 ID 未确认', { cause: error ?? read.error });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async saveObservation(historyId: string, patch: SurplusObservationPatch): Promise<void> {
    if (patch.generation_id) assertIdentity(patch.generation_id);
    if (patch.request_id) assertIdentity(patch.request_id);
    if (patch.response_metadata && jsonBytes(patch.response_metadata) > RESPONSE_LIMIT_BYTES)
      throw new Error('Surplus 响应元数据超过容量');
    const { error } = await this.db
      .rpc('record_surplusintelligence_call', {
        p_history_id: historyId,
        p_patch: patch,
      })
      .abortSignal(AbortSignal.timeout(OPERATION_TIMEOUT_MS));
    if (error) throw new Error('保存 Surplus 调用观测失败', { cause: error });
  }

  async listRecoveryCandidates(input: {
    since: string;
    limit: number;
    now?: string;
  }): Promise<SurplusRecoveryCandidate[]> {
    const limit = Math.min(50, Math.max(1, Math.floor(input.limit)));
    const now = input.now ?? new Date().toISOString();
    const stale = new Date(Date.parse(now) - 120_000).toISOString();
    const { data, error } = await this.db
      .from(TABLE)
      .select(RECOVERY_COLUMNS)
      .not('request_id', 'is', null)
      .eq('request_record_status', 'pending')
      .lt('request_record_attempts', 6)
      .or(
        `call_status.in.(completed,failed,interrupted,unknown),and(call_status.in.(prepared,dispatched),updated_at.lte.${stale})`
      )
      .gte('created_at', input.since)
      .or(`request_record_next_retry_at.is.null,request_record_next_retry_at.lte.${now}`)
      .order('created_at', { ascending: true })
      .limit(limit)
      .abortSignal(AbortSignal.timeout(OPERATION_TIMEOUT_MS));
    if (error) throw new Error('扫描 Surplus 待补齐调用失败', { cause: error });
    return (data ?? []) as SurplusRecoveryCandidate[];
  }

  async claimRequestRecord(historyId: string, now: string): Promise<boolean> {
    const { data, error } = await this.db
      .rpc('claim_surplusintelligence_request_record', {
        p_history_id: historyId,
        p_now: now,
      })
      .abortSignal(AbortSignal.timeout(OPERATION_TIMEOUT_MS));
    if (error) throw new Error('认领 Surplus 请求详情补齐失败', { cause: error });
    return data === true;
  }

  /** Load a large capture only for a claimed row, never for an entire polling batch. */
  async readMetadata(historyId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.db
      .from(TABLE)
      .select('response_metadata')
      .eq('chat_history_id', historyId)
      .abortSignal(AbortSignal.timeout(OPERATION_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error('读取 Surplus 已保存观测失败', { cause: error });
    return data?.response_metadata && typeof data.response_metadata === 'object'
      ? (data.response_metadata as Record<string, unknown>)
      : null;
  }
}
