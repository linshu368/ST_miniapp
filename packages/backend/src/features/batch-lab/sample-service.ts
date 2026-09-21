import { createHash } from 'node:crypto';
import {
  BATCH_LAB_MAX_PREVIEW_BYTES,
  BATCH_LAB_PREVIEW_TTL_SECONDS,
  batchLabPreviewItemSchema,
  batchLabPreviewStatisticsSchema,
  batchLabSnapshotMessageSchema,
  type BatchLabPreview,
  type BatchLabPreviewExclusionReason,
  type BatchLabPreviewItem,
  type BatchLabPreviewRequest,
  type BatchLabPreviewStatistics,
  type BatchLabSnapshotMessage,
  type BatchLabSourceEnvironment,
} from '@miniapp/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  BatchLabRepositoryError,
  BatchLabSampleRepository,
} from '../../infrastructure/repositories/BatchLabSampleRepository.js';
import {
  BatchLabSourceQueryError,
  compileBatchLabSourceSql,
  executeBatchLabSourceQuery,
} from './source-query.js';
import { getBatchLabSourcePool } from './source-database.js';

const DETAIL_QUERY = `
SELECT
  h.id::text AS source_history_id,
  h.session_id::text AS source_session_id,
  h.user_id::text AS source_user_id,
  h.character_id::text AS source_character_id,
  h.turn_index,
  h.revision,
  h.user_input,
  h.assistant_reply AS original_assistant_reply,
  h.model AS original_model,
  h.history,
  h.status,
  s.id::text AS joined_session_id,
  s.context_window_start_turn,
  s.deleted_at AS session_deleted_at,
  c.id::text AS joined_character_id,
  to_jsonb(c) AS character_snapshot
FROM experience.chat_history AS h
LEFT JOIN experience.chat_sessions AS s ON s.id = h.session_id
LEFT JOIN app_core.characters AS c ON c.id = h.character_id
WHERE h.id = ANY($1::uuid[])
`;

type SourceAnchorRow = QueryResultRow & {
  source_history_id?: unknown;
  history_id?: unknown;
  id?: unknown;
};

interface SourceDetailRow extends QueryResultRow {
  source_history_id: string | null;
  source_session_id: string | null;
  source_user_id: string | null;
  source_character_id: string | null;
  turn_index: number | null;
  revision: number | null;
  user_input: string | null;
  original_assistant_reply: string | null;
  original_model: string | null;
  history: unknown;
  status: string | null;
  joined_session_id: string | null;
  context_window_start_turn: number | null;
  session_deleted_at: string | null;
  joined_character_id: string | null;
  character_snapshot: unknown;
}

export class BatchLabSampleService {
  constructor(
    private readonly repository = new BatchLabSampleRepository(),
    private readonly sourcePool: Pick<Pool, 'connect'> = getBatchLabSourcePool()
  ) {}

  async createPreview(request: BatchLabPreviewRequest): Promise<BatchLabPreview> {
    const compiled = compileBatchLabSourceSql(request.sql, request.parameters);
    const anchorResult = await executeBatchLabSourceQuery<SourceAnchorRow>(
      compiled,
      request.sample_limit,
      this.sourcePool
    );
    const anchors = anchorResult.rows.map(readAnchorId);
    const detailRows = await this.fetchDetails(anchors.filter(isUuid));
    const detailById = new Map(detailRows.map((row) => [row.source_history_id, row]));
    const assembled = assemblePreviewItems({
      anchors,
      detailById,
      sampleLimit: request.sample_limit,
      truncated: anchorResult.truncated,
    });
    if (assembled.items.length === 0) {
      throw new BatchLabRepositoryError('BATCH_LAB_EMPTY_PREVIEW', '预览没有有效样本');
    }

    const digest = digestPreview({
      source_environment: request.source_environment,
      sql: compiled.text,
      parameters: request.parameters,
      sample_limit: request.sample_limit,
      source_history_ids: assembled.items.map((item) => item.source_history_id),
    });
    const expiresAt = new Date(Date.now() + BATCH_LAB_PREVIEW_TTL_SECONDS * 1_000).toISOString();
    return this.repository.createPreview({
      digest,
      source_environment: request.source_environment,
      template_key: request.template_key,
      template_version: request.template_version,
      final_sql: compiled.text,
      parameters: request.parameters,
      sample_limit: request.sample_limit,
      statistics: assembled.statistics,
      items: assembled.items,
      expires_at: expiresAt,
    });
  }

  private async fetchDetails(historyIds: string[]): Promise<SourceDetailRow[]> {
    if (historyIds.length === 0) return [];
    let client: PoolClient | undefined;
    try {
      client = await this.sourcePool.connect();
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '500ms'");
      const result = await client.query<SourceDetailRow>(DETAIL_QUERY, [historyIds]);
      await client.query('COMMIT');
      return result.rows;
    } catch (err) {
      if (client) await rollbackQuietly(client);
      if (err instanceof BatchLabSourceQueryError) throw err;
      throw new BatchLabSourceQueryError(
        'BATCH_LAB_SOURCE_UNAVAILABLE',
        'Batch Lab source detail query failed',
        { cause: err }
      );
    } finally {
      client?.release();
    }
  }
}

export function assemblePreviewItems(input: {
  anchors: Array<string | null>;
  detailById: Map<string | null, SourceDetailRow>;
  sampleLimit: number;
  truncated: boolean;
}): { items: BatchLabPreviewItem[]; statistics: BatchLabPreviewStatistics } {
  const seenAnchors = new Set<string>();
  const excluded = new Map<BatchLabPreviewExclusionReason, number>();
  const items: BatchLabPreviewItem[] = [];
  const users = new Set<string>();
  const sessions = new Set<string>();
  const characters = new Set<string>();

  input.anchors.forEach((anchor, index) => {
    if (!anchor || !isUuid(anchor)) {
      increment(excluded, 'invalid_anchor');
      return;
    }
    if (seenAnchors.has(anchor)) {
      increment(excluded, 'duplicate_anchor');
      return;
    }
    seenAnchors.add(anchor);

    const detail = input.detailById.get(anchor);
    const item = detail
      ? toPreviewItem(detail, items.length)
      : { reason: 'missing_history' as const };
    if ('reason' in item) {
      increment(excluded, item.reason);
      return;
    }
    items.push(item);
    users.add(item.source_user_id);
    sessions.add(item.source_session_id);
    characters.add(item.source_character_id);
  });

  const statistics = batchLabPreviewStatisticsSchema.parse({
    requested_count: input.sampleLimit,
    candidate_count: input.anchors.length,
    valid_count: items.length,
    user_count: users.size,
    session_count: sessions.size,
    character_count: characters.size,
    excluded_by_reason: Object.fromEntries(excluded.entries()),
    truncated: input.truncated,
    snapshot_bytes: measurePreviewItems(items),
  });

  return { items, statistics };
}

function toPreviewItem(
  row: SourceDetailRow,
  ordinal: number
): BatchLabPreviewItem | { reason: BatchLabPreviewExclusionReason } {
  if (!row.joined_session_id || row.session_deleted_at !== null)
    return { reason: 'missing_session' };
  if (!row.joined_character_id || !isRecord(row.character_snapshot)) {
    return { reason: 'missing_character' };
  }
  if (
    !isUuid(row.source_history_id) ||
    !isUuid(row.source_session_id) ||
    !isUuid(row.source_user_id) ||
    !isUuid(row.source_character_id) ||
    !Number.isInteger(row.turn_index) ||
    (row.turn_index ?? 0) < 1 ||
    !Number.isInteger(row.revision) ||
    (row.revision ?? -1) < 0 ||
    typeof row.user_input !== 'string' ||
    row.user_input.trim().length === 0 ||
    typeof row.original_model !== 'string' ||
    row.original_model.trim().length === 0
  ) {
    return { reason: 'invalid_anchor' };
  }
  const history = parseHistory(row.history);
  if (!history) return { reason: 'missing_history' };

  return batchLabPreviewItemSchema.parse({
    ordinal,
    source_history_id: row.source_history_id,
    source_session_id: row.source_session_id,
    source_user_id: row.source_user_id,
    source_character_id: row.source_character_id,
    turn_index: row.turn_index,
    revision: row.revision,
    user_input: row.user_input,
    original_assistant_reply: row.original_assistant_reply,
    original_model: row.original_model,
    history,
    character_snapshot: row.character_snapshot,
    dynamic_input_snapshot: {
      context_window_start_turn: row.context_window_start_turn ?? 1,
      source_status: row.status ?? 'unknown',
    },
    restoration_strategy: 'exact_prompt_snapshot',
  });
}

function parseHistory(value: unknown): BatchLabSnapshotMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: BatchLabSnapshotMessage[] = [];
  for (const item of value) {
    const parsed = batchLabSnapshotMessageSchema.safeParse(item);
    if (!parsed.success) return null;
    messages.push(parsed.data);
  }
  return messages;
}

function readAnchorId(row: SourceAnchorRow): string | null {
  const value = row.source_history_id ?? row.history_id ?? row.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function digestPreview(value: {
  source_environment: BatchLabSourceEnvironment;
  sql: string;
  parameters: BatchLabPreviewRequest['parameters'];
  sample_limit: number;
  source_history_ids: string[];
}): `sha256:${string}` {
  const canonical = stableStringify(value);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function measurePreviewItems(items: BatchLabPreviewItem[]): number {
  let bytes = 2;
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (bytes > BATCH_LAB_MAX_PREVIEW_BYTES) {
      throw new BatchLabSourceQueryError(
        'BATCH_LAB_CAPACITY_EXCEEDED',
        'Preview exceeds the maximum snapshot size'
      );
    }
  }
  return bytes;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function increment(
  map: Map<BatchLabPreviewExclusionReason, number>,
  reason: BatchLabPreviewExclusionReason
): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Keep the original query failure as the actionable signal.
  }
}
