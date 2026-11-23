import { safeError, safeName } from './events.js';
import { chatDiagnosticFields } from './chat-fields.js';
import { safeBusinessFields, withoutBusinessIds } from './business-context.js';
import {
  DramaTimingReportSchema,
  dramaTimingLogFields,
} from '@miniapp/shared/src/api/drama-timing';
import { DramaDeliverySchema } from '@miniapp/shared/src/api/drama';

const VALIDATED_DRAMA = Symbol('validatedDramaTiming');

/** Preserve the existing, schema-checked performance report instead of discarding its diagnostics. */
export function validatedDramaLog(report: unknown) {
  const fields = dramaTimingLogFields(DramaTimingReportSchema.parse(report));
  return { ...fields, [VALIDATED_DRAMA]: fields };
}

const TEXT_FIELDS = new Set([
  'event',
  'module',
  'kind',
  'operation',
  'outcome',
  'stage',
  'provider',
  'resource',
  'error_code',
  'errorCode',
  'source',
  'sign_cache',
  'manifest_cache',
  'error_stage',
  'service',
  'event_name',
  'public_error_code',
  'code',
  'errorClass',
  'eventKind',
  'job',
  'reason',
  'method',
  'route',
  'status',
  'trigger',
  'action',
  'model',
  'modelId',
  'paymentType',
  'productType',
  'reqId',
  'request_id',
  'requestId',
  'trace_id',
  'span_id',
  'parent_span_id',
  'event_id',
  'business_key',
  'timestamp',
  'upload_request_id',
  'environment',
  'server_release',
  'experiment_user',
  'experiment_id',
  'assigned_group',
  'experiment_identity',
  'prompt_kind',
  'sort',
  'media',
  'mode',
  'call_scene',
  'probe_result',
  'prompt_version',
  'finish_reason',
]);
const NUMBER_FIELDS = new Set([
  'config_version',
  'ranking_version',
  'pid',
  'schema_version',
  'http_status',
  'upstream_status',
  'statusCode',
  'status',
  'attempt',
  'count',
  'duration_ms',
  'job_attempt',
  'chunk_index',
  'range_start',
  'range_end',
  'target_end',
  'output_chars',
  'input_chars',
  'history_chars',
  'recent_chars',
  'old_memory_chars',
  'prompt_chars',
  'hard_max_chars',
  'validation_max_chars',
  'target_chars',
  'over_limit_chars',
  'input_tokens',
  'output_tokens',
  'max_output_tokens',
  'response_bytes',
  'max_response_bytes',
]);
const BOOLEAN_FIELDS = new Set([
  'outcome_known',
  'success',
  'configured',
  'enabled',
  'acquired',
  'clientGone',
  'recorded',
  'rewarded',
  'with_button',
  'community_prompt',
  'vip_prompt',
  'hasCursor',
  'hasSearch',
  'hasTag',
  'liked',
]);

export function safeLogAttributes(
  record: Record<string, unknown>
): Record<string, string | number | boolean> {
  // Used by Sentry beforeSendSpan and log helpers as well as the final event scrubber.
  const projected = withoutBusinessIds(safeLogRecord(record));
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(projected)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      result[key] = value;
  }
  return result;
}

/** Legacy records are projected too: arbitrary DTO fields and interpolation are not safe logs. */
export function safeLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const validated = (record as { [VALIDATED_DRAMA]?: ReturnType<typeof dramaTimingLogFields> })[
    VALIDATED_DRAMA
  ];
  const result: Record<string, unknown> = { ...validated, ...safeBusinessFields(record) };
  Object.assign(result, chatDiagnosticFields(record));
  for (const [key, value] of Object.entries(record)) {
    if (TEXT_FIELDS.has(key) && typeof value === 'string') result[key] = safeName(value);
    else if (
      (NUMBER_FIELDS.has(key) || /(?:Count|Ms|_ms|_count)$/.test(key)) &&
      typeof value === 'number' &&
      Number.isFinite(value)
    )
      result[key] = value;
    else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') result[key] = value;
    else if (key === 'delivery' && record.event === 'drama.request_timing') {
      const parsed = DramaDeliverySchema.safeParse(value);
      if (parsed.success) result.delivery = parsed.data;
    } else if (key === 'err')
      result.err = value; // Pino's err serializer owns this boundary.
    else if (key === 'error' && value && typeof value === 'object') {
      // Re-project foundation errors without discarding their bounded cause/code chain.
      result.error = safeError(value);
    } else if (key === 'req' && value && typeof value === 'object') {
      const req = value as { method?: unknown; id?: unknown; url?: unknown };
      result.req = {
        method: safeName(req.method),
        id: safeName(req.id),
        url: typeof req.url === 'string' ? safeName(req.url.split('?')[0]) : undefined,
      };
    } else if (key === 'res' && value && typeof value === 'object') {
      const status = (value as { statusCode?: unknown }).statusCode;
      result.res = { statusCode: typeof status === 'number' ? status : undefined };
    } else if ((key === 'http_status' || key === 'upstream_status') && value === null)
      result[key] = null;
  }
  return result;
}
