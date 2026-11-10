import type { FastifyBaseLogger } from 'fastify';
import {
  SurplusIntelligenceChatHistoryRepository,
  type SurplusObservationPatch,
  type SurplusRecoveryCandidate,
} from '../../infrastructure/repositories/SurplusIntelligenceChatHistoryRepository.js';
import { getLlmProviderRuntimeConfig } from '../../platform/runtime-config.js';
import { SurplusResponseCapture } from './surplus-response-capture.js';

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const FETCH_LIMIT = 9;
const MAX_BODY_BYTES = 128 * 1024;

interface RecoveryRepository {
  listRecoveryCandidates(input: {
    since: string;
    limit: number;
    now: string;
  }): Promise<SurplusRecoveryCandidate[]>;
  claimRequestRecord(historyId: string, now: string): Promise<boolean>;
  readMetadata(historyId: string): Promise<Record<string, unknown> | null>;
  saveObservation(historyId: string, patch: SurplusObservationPatch): Promise<void>;
}

export interface SurplusMetadataRecoveryResult {
  scanned: number;
  claimed: number;
  completed: number;
  deferred: number;
  unavailable: number;
  failed: number;
}

function capturePatch(capture: SurplusResponseCapture): SurplusObservationPatch {
  const value = capture.projection();
  const snapshot = capture.snapshot();
  const status = (snapshot.capture as { status?: unknown } | undefined)?.status;
  return {
    // Request-log IDs and completion IDs are separate. Only the live transport freezes identity.
    model: value.model,
    provider_name: value.providerName,
    error_code: value.errorCode,
    finish_reason: value.finishReason,
    prompt_tokens: value.promptTokens,
    completion_tokens: value.completionTokens,
    total_tokens: value.totalTokens,
    cached_tokens: value.cachedTokens,
    reasoning_tokens: value.reasoningTokens,
    buyer_cost_micro: value.buyerCostMicro,
    usage_usd: value.usageUsd,
    response_metadata: snapshot,
    metadata_capture_status: status === 'complete' || status === 'unavailable' ? status : 'partial',
  };
}

/** Bound the body before parsing; a provider error/diagnostic must not exhaust worker memory. */
async function readDetail(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Surplus 请求详情缺少响应体');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('Surplus 请求详情超过容量');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateDetailIdentity(value: unknown, record: SurplusRecoveryCandidate): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Surplus 请求详情格式非法');
  const envelope = value as Record<string, unknown>;
  const candidate = envelope.data ?? envelope.request ?? envelope;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('Surplus 请求详情格式非法');
  const detail = candidate as Record<string, unknown>;
  const identifiers = [detail.id, detail.request_id].filter((id) => id !== undefined);
  if (identifiers.length === 0 || identifiers.some((id) => id !== record.request_id))
    throw new Error('Surplus 请求详情身份冲突');
  if (
    record.generation_id &&
    detail.generation_id !== undefined &&
    detail.generation_id !== record.generation_id
  )
    throw new Error('Surplus 请求详情身份冲突');
}

async function recoverRecord(input: {
  record: SurplusRecoveryCandidate;
  repository: RecoveryRepository;
  fetchImpl: typeof fetch;
  baseUrl: string;
  apiKey: string;
}): Promise<'completed' | 'deferred' | 'unavailable'> {
  const { record, repository } = input;
  const capture = new SurplusResponseCapture(await repository.readMetadata(record.chat_history_id));
  if (!/^[a-zA-Z0-9_.:-]{1,512}$/.test(record.request_id)) {
    capture.unavailable('request_record', 'invalid');
    await repository.saveObservation(record.chat_history_id, {
      ...capturePatch(capture),
      request_record_status: 'unavailable',
    });
    return 'unavailable';
  }
  let outcome: 'completed' | 'deferred' | 'unavailable' = 'deferred';
  let requestStatus: SurplusObservationPatch['request_record_status'] = 'pending';
  try {
    const response = await input.fetchImpl(
      `${input.baseUrl.replace(/\/+$/, '')}/requests/${encodeURIComponent(record.request_id)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      }
    );
    if (response.ok) {
      const detail = await readDetail(response);
      validateDetailIdentity(detail, record);
      capture.observe(detail, 'request_record');
      requestStatus = 'complete';
      outcome = 'completed';
    } else {
      await response.body?.cancel().catch(() => undefined);
      const terminal =
        response.status === 401 || response.status === 403 || response.status === 404;
      requestStatus = response.status === 404 ? 'not_found' : terminal ? 'forbidden' : 'pending';
      capture.unavailable('request_record', terminal ? requestStatus : 'http_error');
      outcome = terminal ? 'unavailable' : 'deferred';
    }
  } catch (err) {
    // Never retain the raw provider body, URL, transport exception or credentials.
    const timeout = err instanceof Error && ['TimeoutError', 'AbortError'].includes(err.name);
    capture.unavailable('request_record', timeout ? 'timeout' : 'invalid');
  }
  if (outcome === 'deferred' && record.request_record_attempts >= 5) {
    requestStatus = 'unavailable';
    outcome = 'unavailable';
    capture.unavailable('request_record', 'http_error');
  }
  await repository.saveObservation(record.chat_history_id, {
    ...capturePatch(capture),
    request_record_status: requestStatus,
    // A restarted worker did not observe this transport's terminal event itself.
    ...(['prepared', 'dispatched'].includes(record.call_status)
      ? { call_status: 'unknown' as const }
      : {}),
  });
  return outcome;
}

/** Metadata-only recovery. It never writes chat_history, replays inference or enters billing. */
export async function recoverSurplusRequestMetadata(input: {
  log: FastifyBaseLogger;
  repository?: RecoveryRepository;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  baseUrl?: string;
  now?: number;
  requestBudget?: number;
}): Promise<SurplusMetadataRecoveryResult> {
  const result: SurplusMetadataRecoveryResult = {
    scanned: 0,
    claimed: 0,
    completed: 0,
    deferred: 0,
    unavailable: 0,
    failed: 0,
  };
  const runtime = getLlmProviderRuntimeConfig('surplus');
  const apiKey = input.apiKey ?? runtime.apiKey;
  const budget = Math.min(FETCH_LIMIT, Math.max(0, Math.floor(input.requestBudget ?? FETCH_LIMIT)));
  if (!apiKey || !budget) return result;
  const now = input.now ?? Date.now();
  const repository = input.repository ?? new SurplusIntelligenceChatHistoryRepository();
  const records = await repository.listRecoveryCandidates({
    since: new Date(now - LOOKBACK_MS).toISOString(),
    limit: 50,
    now: new Date(now).toISOString(),
  });
  result.scanned = records.length;
  // Three workers bound large captures to three rows and nine 5s fetches to three waves.
  const candidates = records.slice(0, budget);
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      const record = candidates[next++];
      if (!record) continue;
      try {
        if (
          !(await repository.claimRequestRecord(
            record.chat_history_id,
            new Date(now).toISOString()
          ))
        )
          continue;
        result.claimed++;
        const outcome = await recoverRecord({
          record,
          repository,
          apiKey,
          baseUrl: input.baseUrl ?? runtime.baseUrl,
          fetchImpl: input.fetchImpl ?? fetch,
        });
        result[outcome]++;
      } catch (err) {
        result.failed++;
        input.log.error(
          { err, event: 'surplus.request_record.recovery_failed' },
          'Surplus 请求详情补齐失败'
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
  return result;
}
