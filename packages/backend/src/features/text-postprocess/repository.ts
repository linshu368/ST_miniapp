import {
  TEXT_POSTPROCESS_LIMITS,
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  TextPostprocessAdminStateSchema,
  TextPostprocessMutationOutcomeSchema,
  TextPostprocessVersionSnapshotSchema,
  TextPostprocessArtifactSnapshotSchema,
  validateCompiledArtifact,
  type TextPostprocessArtifactSnapshot,
  parseTextPostprocessDraft,
  type TextPostprocessAdminState,
  type TextPostprocessMutationOutcome,
  type TextPostprocessVersionSnapshot,
} from '@miniapp/shared';
import { config } from '../../platform/config.js';
import { getDomainDb, type DomainDb } from '../../lib/supabase.js';
import { TEXT_POSTPROCESS_CONFIG_KEY } from './constants.js';
import { isDefiniteDatabaseError, type RpcFailure } from './errors.js';

const SNAPSHOT_COLUMNS = 'version, source, schema_version, policy_version, published_at';

export type RpcCall<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'database'; error: RpcFailure }
  | { kind: 'transport' };

interface SnapshotRow {
  version: unknown;
  source: unknown;
  artifact?: unknown;
  schema_version: unknown;
  policy_version: unknown;
  published_at: unknown;
}

export interface StoredDraft {
  draftRevision: string;
  updatedAt: string;
  contentDigest: string;
  baseVersion: number;
  source: unknown;
}

export class TextPostprocessRepository {
  constructor(
    private readonly appCore: DomainDb = getDomainDb('app_core'),
    private readonly admin: DomainDb = getDomainDb('admin'),
    private readonly environment: 'test' | 'production' = config.database.target
  ) {}

  /**
   * 一批版本一次查询。读不到、schema/policy 不支持的版本放进 unavailable，不用别的版本填上。
   */
  async readSnapshots(versions: readonly number[]): Promise<{
    found: TextPostprocessArtifactSnapshot[];
    unavailable_versions: number[];
  }> {
    if (
      versions.length < 1 ||
      versions.length > TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch ||
      new Set(versions).size !== versions.length
    ) {
      throw new Error('text postprocess version batch is outside the shared contract');
    }
    const { data, error } = await this.appCore
      .from('text_postprocess_versions')
      .select('version,artifact,schema_version,policy_version,published_at')
      .in('version', [...versions]);
    if (error) throw new Error('text postprocess snapshot read failed');
    const byVersion = new Map<number, TextPostprocessArtifactSnapshot>();
    for (const row of (data ?? []) as SnapshotRow[]) {
      const snapshot = toArtifactSnapshot(row);
      if (snapshot) byVersion.set(snapshot.version, snapshot);
    }
    const found: TextPostprocessArtifactSnapshot[] = [];
    const unavailable: number[] = [];
    for (const version of versions) {
      const snapshot = byVersion.get(version);
      if (snapshot) found.push(snapshot);
      else unavailable.push(version);
    }
    return { found, unavailable_versions: unavailable };
  }

  async readAdminState(input: {
    limit: number;
    beforeVersion?: number;
    runtimeVersion: number | null;
  }): Promise<TextPostprocessAdminState> {
    const limit = Math.min(Math.max(input.limit, 1), TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch);
    let historyQuery = this.appCore
      .from('text_postprocess_versions')
      .select(SNAPSHOT_COLUMNS)
      .order('version', { ascending: false })
      .limit(limit + 1);
    if (typeof input.beforeVersion === 'number') {
      historyQuery = historyQuery.lt('version', input.beforeVersion);
    }
    const [draftResult, historyResult] = await Promise.all([
      this.admin
        .from('config_drafts')
        .select('id,value,content_digest,updated_at,base_version')
        .eq('environment', this.environment)
        .eq('config_key', TEXT_POSTPROCESS_CONFIG_KEY)
        .eq('status', 'draft')
        .maybeSingle(),
      historyQuery,
    ]);
    if (draftResult.error || historyResult.error) {
      throw new Error('text postprocess admin state read failed');
    }
    const runtimeVersion = input.runtimeVersion;
    const published = runtimeVersion === null ? null : await this.readOneSnapshot(runtimeVersion);
    const rows = (historyResult.data ?? []) as SnapshotRow[];
    const hasMore = rows.length > limit;
    const history = rows
      .slice(0, limit)
      .map((row) => toSnapshot(row))
      .filter((row): row is TextPostprocessVersionSnapshot => row !== null);
    const state = {
      runtime_version: runtimeVersion,
      published,
      draft: toDraftState(draftResult.data),
      history,
      has_more: hasMore,
    };
    const parsed = TextPostprocessAdminStateSchema.safeParse(state);
    if (!parsed.success) throw new Error('text postprocess admin state shape was rejected');
    return parsed.data;
  }

  async readDraft(): Promise<StoredDraft | null> {
    const { data, error } = await this.admin
      .from('config_drafts')
      .select('id,value,content_digest,updated_at,base_version')
      .eq('environment', this.environment)
      .eq('config_key', TEXT_POSTPROCESS_CONFIG_KEY)
      .eq('status', 'draft')
      .maybeSingle();
    if (error) throw new Error('text postprocess draft read failed');
    return toStoredDraft(data);
  }

  async readSnapshotSource(version: number): Promise<unknown | null> {
    const { data, error } = await this.appCore
      .from('text_postprocess_versions')
      .select('version,source,artifact,schema_version,policy_version')
      .eq('version', version)
      .maybeSingle();
    if (error) throw new Error('text postprocess snapshot read failed');
    if (!data) return null;
    return data;
  }

  async saveDraft(args: Record<string, unknown>): Promise<RpcCall<TextPostprocessMutationOutcome>> {
    return this.call('save_text_postprocess_draft', args);
  }

  async publish(args: Record<string, unknown>): Promise<RpcCall<TextPostprocessMutationOutcome>> {
    return this.call('publish_text_postprocess', args);
  }

  async rollback(args: Record<string, unknown>): Promise<RpcCall<TextPostprocessMutationOutcome>> {
    return this.call('rollback_text_postprocess', args);
  }

  async discardDraft(
    args: Record<string, unknown>
  ): Promise<RpcCall<TextPostprocessMutationOutcome>> {
    return this.call('discard_text_postprocess_draft', args);
  }

  async getRequest(
    actorUserId: string,
    requestId: string
  ): Promise<RpcCall<TextPostprocessMutationOutcome | null>> {
    const { data, error } = await this.admin.rpc('get_text_postprocess_request', {
      p_actor_user_id: actorUserId,
      p_request_id: requestId,
    });
    if (error) {
      return isDefiniteDatabaseError(error) ? { kind: 'database', error } : { kind: 'transport' };
    }
    if (data === null) return { kind: 'ok', value: null };
    const outcome = toOutcome(data);
    if (!outcome) return { kind: 'transport' };
    return { kind: 'ok', value: outcome };
  }

  private async readOneSnapshot(version: number): Promise<TextPostprocessVersionSnapshot | null> {
    const { data, error } = await this.appCore
      .from('text_postprocess_versions')
      .select(SNAPSHOT_COLUMNS)
      .eq('version', version)
      .maybeSingle();
    if (error) throw new Error('text postprocess snapshot read failed');
    if (!data) return null;
    return toSnapshot(data as SnapshotRow);
  }

  private async call(
    fn: string,
    args: Record<string, unknown>
  ): Promise<RpcCall<TextPostprocessMutationOutcome>> {
    try {
      const { data, error } = await this.admin.rpc(fn, args);
      if (error) {
        return isDefiniteDatabaseError(error) ? { kind: 'database', error } : { kind: 'transport' };
      }
      const outcome = toOutcome(data);
      if (!outcome) return { kind: 'transport' };
      return { kind: 'ok', value: outcome };
    } catch {
      return { kind: 'transport' };
    }
  }
}

function toArtifactSnapshot(row: SnapshotRow): TextPostprocessArtifactSnapshot | null {
  if (!row || typeof row !== 'object') return null;
  if (
    row.schema_version !== TEXT_POSTPROCESS_SCHEMA_VERSION ||
    row.policy_version !== TEXT_POSTPROCESS_POLICY_VERSION
  )
    return null;
  const artifact = validateCompiledArtifact(row.artifact);
  if (!artifact.ok) return null;
  const parsed = TextPostprocessArtifactSnapshotSchema.safeParse({
    version: row.version,
    artifact: artifact.artifact,
    published_at: toIso(row.published_at),
  });
  return parsed.success ? parsed.data : null;
}

function toSnapshot(row: SnapshotRow): TextPostprocessVersionSnapshot | null {
  if (row.schema_version !== TEXT_POSTPROCESS_SCHEMA_VERSION) return null;
  if (row.policy_version !== TEXT_POSTPROCESS_POLICY_VERSION) return null;
  const publishedAt = toIso(row.published_at);
  if (!publishedAt || typeof row.version !== 'number') return null;
  const parsed = TextPostprocessVersionSnapshotSchema.safeParse({
    version: row.version,
    schema_version: row.schema_version,
    policy_version: row.policy_version,
    source: row.source,
    published_at: publishedAt,
  });
  return parsed.success ? parsed.data : null;
}

function toStoredDraft(data: unknown): StoredDraft | null {
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  const updatedAt = toIso(row.updated_at);
  if (typeof row.id !== 'string' || !updatedAt) return null;
  if (typeof row.content_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.content_digest))
    return null;
  if (
    typeof row.base_version !== 'number' ||
    !Number.isInteger(row.base_version) ||
    row.base_version < 0
  ) {
    return null;
  }
  return {
    draftRevision: row.id,
    updatedAt,
    contentDigest: row.content_digest,
    baseVersion: row.base_version,
    source: row.value,
  };
}

function toDraftState(data: unknown): TextPostprocessAdminState['draft'] {
  const stored = toStoredDraft(data);
  if (!stored) return null;
  const parsed = parseTextPostprocessDraft(stored.source);
  return {
    draft_revision: stored.draftRevision,
    updated_at: stored.updatedAt,
    content_digest: stored.contentDigest,
    base_version: stored.baseVersion,
    source: parsed.ok ? parsed.source : null,
  };
}

function toOutcome(data: unknown): TextPostprocessMutationOutcome | null {
  const record = typeof data === 'string' ? parseJson(data) : data;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const row = record as Record<string, unknown>;
  const candidate: Record<string, unknown> = {};
  if (
    row.action === 'save' ||
    row.action === 'publish' ||
    row.action === 'rollback' ||
    row.action === 'discard'
  ) {
    candidate.action = row.action;
  }
  if (typeof row.replayed === 'boolean') candidate.replayed = row.replayed;
  copyString(candidate, 'draft_id', row.draft_id);
  copyString(candidate, 'draft_revision', row.draft_revision);
  const updatedAt = toIso(row.updated_at);
  if (updatedAt) candidate.updated_at = updatedAt;
  copyString(candidate, 'content_digest', row.content_digest);
  copyNumber(candidate, 'base_version', row.base_version);
  if (row.runtime_version === null) candidate.runtime_version = null;
  else copyNumber(candidate, 'runtime_version', row.runtime_version);
  copyNumber(candidate, 'version', row.version);
  copyNumber(candidate, 'schema_version', row.schema_version);
  copyNumber(candidate, 'policy_version', row.policy_version);
  const publishedAt = toIso(row.published_at);
  if (publishedAt) candidate.published_at = publishedAt;
  copyString(candidate, 'release_id', row.release_id);
  copyNumber(candidate, 'target_version', row.target_version);
  copyString(candidate, 'rollback_of_release_id', row.rollback_of_release_id);
  const parsed = TextPostprocessMutationOutcomeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function copyString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target[key] = value;
}

function copyNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}
