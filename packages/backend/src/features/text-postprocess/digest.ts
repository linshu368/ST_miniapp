import { createHash } from 'node:crypto';
import { canonicalTextPostprocessJson } from '@miniapp/shared';
import type {
  DiscardTextPostprocessDraftRequest,
  PublishTextPostprocessRequest,
  RollbackTextPostprocessRequest,
  SaveTextPostprocessDraftRequest,
  TextPostprocessDraftSource,
} from '@miniapp/shared';

/** SHA-256 of the shared canonical JSON. 不另写一套键序。 */
export function textPostprocessDigest(value: unknown): string {
  return createHash('sha256').update(canonicalTextPostprocessJson(value), 'utf8').digest('hex');
}

export function sourceContentDigest(source: TextPostprocessDraftSource): string {
  return textPostprocessDigest(source);
}

/**
 * request_digest 覆盖操作名和会写入 RPC 的业务参数。
 * 不把 request_id 或 actor 算进摘要：request_id 是幂等键，摘要用来发现同一个键的内容冲突。
 */
export function saveRequestDigest(
  input: SaveTextPostprocessDraftRequest,
  contentDigest: string
): string {
  return textPostprocessDigest({
    action: 'save',
    content_digest: contentDigest,
    expected_draft_digest: input.expected_draft_digest,
    expected_draft_updated_at: input.expected_draft_updated_at,
    expected_runtime_version: input.expected_runtime_version,
    source: input.source,
  });
}

export function publishRequestDigest(
  input: PublishTextPostprocessRequest,
  payload?: { source: unknown; artifact: unknown }
): string {
  return textPostprocessDigest({
    action: 'publish',
    ...payload,
    draft_revision: input.draft_revision,
    expected_draft_digest: input.expected_draft_digest,
    expected_draft_updated_at: input.expected_draft_updated_at,
    expected_runtime_version: input.expected_runtime_version,
  });
}

export function rollbackRequestDigest(
  input: RollbackTextPostprocessRequest,
  payload?: { source: unknown; artifact: unknown }
): string {
  return textPostprocessDigest({
    action: 'rollback',
    ...payload,
    expected_runtime_version: input.expected_runtime_version,
    target_version: input.target_version,
  });
}

export function discardRequestDigest(input: DiscardTextPostprocessDraftRequest): string {
  return textPostprocessDigest({
    action: 'discard',
    expected_draft_digest: input.expected_draft_digest,
    expected_draft_updated_at: input.expected_draft_updated_at,
  });
}
