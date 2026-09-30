import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  validateCompiledArtifact,
  type CompiledTextPostprocessArtifact,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  type DiscardTextPostprocessDraftRequest,
  type PublishTextPostprocessRequest,
  type ReadTextPostprocessVersionsData,
  type RollbackTextPostprocessRequest,
  type SaveTextPostprocessDraftRequest,
  type TextPostprocessAdminState,
  type TextPostprocessMutationOutcome,
  type TextPostprocessRequestLookup,
} from '@miniapp/shared';
import {
  discardRequestDigest,
  publishRequestDigest,
  rollbackRequestDigest,
  saveRequestDigest,
  sourceContentDigest,
  textPostprocessDigest,
} from './digest.js';
import {
  mapTextPostprocessRpcError,
  mutationError,
  TextPostprocessRequestError,
} from './errors.js';
import { primeCurrentPostprocessVersion, readAdminPostprocessVersion } from './config.js';
import { TextPostprocessRepository, type RpcCall, type StoredDraft } from './repository.js';
import { validateTextPostprocessSource } from './validate-pool.js';

let repository: TextPostprocessRepository | null = null;

function records(): TextPostprocessRepository {
  return (repository ??= new TextPostprocessRepository());
}

export function setTextPostprocessRepositoryForTests(next: TextPostprocessRepository | null): void {
  repository = next;
}

export async function readTextPostprocessVersions(
  versions: readonly number[]
): Promise<ReadTextPostprocessVersionsData> {
  return records().readSnapshots(versions);
}

export async function readTextPostprocessAdminState(input: {
  limit: number;
  beforeVersion?: number;
}): Promise<TextPostprocessAdminState> {
  const runtimeVersion = await readAdminPostprocessVersion();
  return records().readAdminState({ ...input, runtimeVersion });
}

export async function readTextPostprocessRequest(
  actorUserId: string,
  requestId: string
): Promise<TextPostprocessRequestLookup> {
  const lookedUp = await records().getRequest(actorUserId, requestId);
  if (lookedUp.kind === 'ok') return { outcome: lookedUp.value };
  if (lookedUp.kind === 'database') {
    const mapped = mapTextPostprocessRpcError(lookedUp.error);
    if (mapped) throw mutationError(mapped);
  }
  throw new TextPostprocessRequestError(
    503,
    'RESULT_UNKNOWN',
    'The request result could not be read.'
  );
}

export async function saveTextPostprocessDraft(
  actorUserId: string,
  input: SaveTextPostprocessDraftRequest
): Promise<TextPostprocessMutationOutcome> {
  const contentDigest = sourceContentDigest(input.source);
  const requestDigest = saveRequestDigest(input, contentDigest);
  return settle(
    await records().saveDraft({
      p_actor_user_id: actorUserId,
      p_request_id: input.request_id,
      p_request_digest: requestDigest,
      p_expected_runtime_version: input.expected_runtime_version,
      p_expected_draft_updated_at: input.expected_draft_updated_at,
      p_expected_draft_digest: input.expected_draft_digest,
      p_content_digest: contentDigest,
      p_source: input.source,
    }),
    () => records().getRequest(actorUserId, input.request_id)
  );
}

export async function publishTextPostprocess(
  actorUserId: string,
  input: PublishTextPostprocessRequest
): Promise<TextPostprocessMutationOutcome> {
  const replay = await confirmedReplay(actorUserId, input.request_id, async (outcome) => {
    const payload = await committedPayload(outcome);
    return records().publish({
      ...publishArgs(actorUserId, input, publishRequestDigest(input, payload)),
      p_source: payload.source,
      p_artifact: payload.artifact,
    });
  });
  if (replay) return replay;
  const draft = await records().readDraft();
  assertPublishTarget(draft, input);
  const artifact = await assertCompilable(draft.source);
  const payload = { source: draft.source, artifact };
  const outcome = await settle(
    await records().publish({
      ...publishArgs(actorUserId, input, publishRequestDigest(input, payload)),
      p_source: draft.source,
      p_artifact: artifact,
    }),
    () => records().getRequest(actorUserId, input.request_id)
  );
  primeCommittedVersion(outcome);
  return outcome;
}

export async function rollbackTextPostprocess(
  actorUserId: string,
  input: RollbackTextPostprocessRequest
): Promise<TextPostprocessMutationOutcome> {
  const replay = await confirmedReplay(actorUserId, input.request_id, async (outcome) => {
    const payload = await committedPayload(outcome);
    return records().rollback({
      ...rollbackArgs(actorUserId, input, rollbackRequestDigest(input, payload)),
      p_source: payload.source,
      p_artifact: payload.artifact,
    });
  });
  if (replay) return replay;
  const snapshot = await records().readSnapshotSource(input.target_version);
  if (!snapshot || typeof snapshot !== 'object') throw mutationError('target_version_unavailable');
  const row = snapshot as Record<string, unknown>;
  if (row.version !== input.target_version) throw mutationError('target_version_unavailable');
  if (row.policy_version !== TEXT_POSTPROCESS_POLICY_VERSION)
    throw mutationError('policy_unsupported');
  if (row.schema_version !== TEXT_POSTPROCESS_SCHEMA_VERSION) throw mutationError('invalid_source');
  const artifact = await assertCompilable(row.source);
  const payload = { source: row.source, artifact };
  const outcome = await settle(
    await records().rollback({
      ...rollbackArgs(actorUserId, input, rollbackRequestDigest(input, payload)),
      p_source: row.source,
      p_artifact: artifact,
    }),
    () => records().getRequest(actorUserId, input.request_id)
  );
  primeCommittedVersion(outcome);
  return outcome;
}

export async function discardTextPostprocessDraft(
  actorUserId: string,
  input: DiscardTextPostprocessDraftRequest
): Promise<TextPostprocessMutationOutcome> {
  const requestDigest = discardRequestDigest(input);
  return settle(
    await records().discardDraft({
      p_actor_user_id: actorUserId,
      p_request_id: input.request_id,
      p_request_digest: requestDigest,
      p_expected_draft_updated_at: input.expected_draft_updated_at,
      p_expected_draft_digest: input.expected_draft_digest,
    }),
    () => records().getRequest(actorUserId, input.request_id)
  );
}

/**
 * 已有 request_id 时先让写 RPC 判断摘要，不在这里编译。
 * 没有记录返回 null，调用方再做校验并提交一次。
 */
async function confirmedReplay(
  actorUserId: string,
  requestId: string,
  confirm: (
    outcome: TextPostprocessMutationOutcome
  ) => Promise<RpcCall<TextPostprocessMutationOutcome>>
): Promise<TextPostprocessMutationOutcome | null> {
  const existing = await records().getRequest(actorUserId, requestId);
  if (existing.kind === 'transport') {
    throw new TextPostprocessRequestError(
      503,
      'RESULT_UNKNOWN',
      'The result was not confirmed. Retry the same request id.'
    );
  }
  if (existing.kind === 'database') {
    const mapped = mapTextPostprocessRpcError(existing.error);
    if (mapped) throw mutationError(mapped);
    throw new TextPostprocessRequestError(
      500,
      'TEXT_POSTPROCESS_FAILED',
      'Text postprocess request failed.'
    );
  }
  if (!existing.value) return null;
  return settle(await confirm(existing.value), () => records().getRequest(actorUserId, requestId));
}

function primeCommittedVersion(outcome: TextPostprocessMutationOutcome): void {
  if (!outcome.replayed && outcome.version) primeCurrentPostprocessVersion(outcome.version);
}

/** 重放读取已提交的明确版本，不依赖已关闭的 draft 或 current，也不重新编译。 */
async function committedPayload(
  outcome: TextPostprocessMutationOutcome
): Promise<{ source: unknown; artifact: CompiledTextPostprocessArtifact }> {
  if (!outcome.version) throw mutationError('request_id_conflict');
  const value = await records().readSnapshotSource(outcome.version);
  if (!value || typeof value !== 'object') throw mutationError('target_version_unavailable');
  const row = value as Record<string, unknown>;
  const checked = validateCompiledArtifact(row.artifact);
  if (row.version !== outcome.version || !checked.ok)
    throw mutationError('target_version_unavailable');
  return { source: row.source, artifact: checked.artifact };
}

function publishArgs(
  actorUserId: string,
  input: PublishTextPostprocessRequest,
  requestDigest: string
): Record<string, unknown> {
  return {
    p_actor_user_id: actorUserId,
    p_request_id: input.request_id,
    p_request_digest: requestDigest,
    p_expected_runtime_version: input.expected_runtime_version,
    p_expected_draft_updated_at: input.expected_draft_updated_at,
    p_expected_draft_digest: input.expected_draft_digest,
    p_draft_revision: input.draft_revision,
  };
}

function rollbackArgs(
  actorUserId: string,
  input: RollbackTextPostprocessRequest,
  requestDigest: string
): Record<string, unknown> {
  return {
    p_actor_user_id: actorUserId,
    p_request_id: input.request_id,
    p_request_digest: requestDigest,
    p_expected_runtime_version: input.expected_runtime_version,
    p_target_version: input.target_version,
  };
}

function assertPublishTarget(
  draft: StoredDraft | null,
  input: PublishTextPostprocessRequest
): asserts draft is StoredDraft {
  if (!draft) throw mutationError('invalid_draft');
  if (draft.draftRevision !== input.draft_revision) throw mutationError('draft_revision_mismatch');
  if (
    draft.contentDigest !== input.expected_draft_digest ||
    textPostprocessDigest(draft.source) !== draft.contentDigest ||
    new Date(draft.updatedAt).getTime() !== new Date(input.expected_draft_updated_at).getTime()
  ) {
    throw mutationError('cas_conflict');
  }
}

async function assertCompilable(source: unknown): Promise<CompiledTextPostprocessArtifact> {
  const result = await validateTextPostprocessSource(source);
  if (result.ok) {
    const checked = validateCompiledArtifact(result.artifact);
    if (checked.ok) return checked.artifact;
    throw mutationError('compile_rejected');
  }
  if (result.reason === 'rejected') throw mutationError('compile_rejected', result.diagnostics);
  throw new TextPostprocessRequestError(
    503,
    'VALIDATION_UNAVAILABLE',
    'Text postprocess validation is unavailable.'
  );
}

async function settle(
  call: RpcCall<TextPostprocessMutationOutcome>,
  recover: () => Promise<RpcCall<TextPostprocessMutationOutcome | null>>
): Promise<TextPostprocessMutationOutcome> {
  if (call.kind === 'ok') return call.value;
  if (call.kind === 'database') {
    const mapped = mapTextPostprocessRpcError(call.error);
    if (mapped) throw mutationError(mapped);
    throw new TextPostprocessRequestError(
      500,
      'TEXT_POSTPROCESS_FAILED',
      'Text postprocess request failed.'
    );
  }
  const lookedUp = await recover();
  if (lookedUp.kind === 'ok' && lookedUp.value) return lookedUp.value;
  throw new TextPostprocessRequestError(
    503,
    'RESULT_UNKNOWN',
    'The result was not confirmed. Retry the same request id.'
  );
}
