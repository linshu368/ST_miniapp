import { Buffer } from 'node:buffer';
import {
  ImagePlazaSnapshotSchema,
  type ImagePlazaArtifact,
  type ImagePlazaAttempt,
  type ImagePlazaConversation,
  type ProviderImagePlazaModel,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

/** 结算响应未知与已确认未扣款必须分开，worker 才不会误删成果或误报成功。 */
export class ImagePlazaSettlementError extends Error {
  readonly outcomeUnknown: boolean;

  constructor(
    readonly code: 'image_plaza_settlement_outcome_unknown' | 'image_plaza_insufficient_balance',
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = 'ImagePlazaSettlementError';
    this.outcomeUnknown = code === 'image_plaza_settlement_outcome_unknown';
  }
}

export interface ImagePlazaWorkerAttempt {
  id: string;
  userId: string;
  prompt: string;
  providerModelId: string;
  editProviderModelId: string | null;
  sizingMode: ProviderImagePlazaModel['sizing_mode'];
  mode: 't2i' | 'i2i' | 'edit';
  aspectRatio: string;
  resolution: '1K' | '2K' | 'fixed';
  autoOptimize: boolean;
  referenceArtifactId: string | null;
}

export interface WorkRow {
  id: string;
  user_id: string;
  attempt_id: string;
  artifact_id: string;
  title: string;
  model_id: string;
  model_name: string;
  width: number;
  height: number;
  tags: string[];
  snapshot: unknown;
  like_count: number;
  published_at: string;
  deleted_at: string | null;
  initial_feed_order?: string | null;
}

export const WORK_COLUMNS =
  'id,user_id,attempt_id,artifact_id,title,model_id,model_name,width,height,tags,snapshot,like_count,published_at,deleted_at,initial_feed_order::text';

export interface ArtifactRow {
  id: string;
  attempt_id: string;
  position: number;
  storage_path: string;
  width: number;
  height: number;
}

export interface AttemptRow {
  id: string;
  user_id: string;
  conversation_id: string;
  assistant_message_id: string;
  quote_credits: number;
  status: string;
  error_code: string | null;
  reference_artifact_id: string | null;
  quote_id: string;
  prompt: string;
  model_id: string;
  mode: 't2i' | 'i2i' | 'edit';
  aspect_ratio: string;
  resolution: '1K' | '2K' | 'fixed';
  reasoning: boolean;
  auto_optimize: boolean;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  snapshot: unknown;
  created_at: string;
  updated_at: string;
}

export function mapAttemptRow(row: AttemptRow, artifacts: ImagePlazaArtifact[]): ImagePlazaAttempt {
  const status = row.status === 'leased' || row.status === 'storing' ? 'generating' : row.status;
  if (!['pending', 'generating', 'ready', 'failed', 'failed_unknown'].includes(status)) {
    throw new Error('image_plaza_attempt_status_invalid');
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    status: status as ImagePlazaAttempt['status'],
    quote_credits: Number(row.quote_credits),
    error_code: row.error_code,
    artifacts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mapConversationRow(
  row: ConversationRow,
  messages: Array<MessageRow & { attempt?: ImagePlazaAttempt | null }>
): ImagePlazaConversation {
  const snapshot = row.snapshot === null ? null : ImagePlazaSnapshotSchema.parse(row.snapshot);
  return {
    id: row.id,
    title: row.title,
    snapshot,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attempt: message.attempt ?? null,
      created_at: message.created_at,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function escapeIlikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function encodeCursor(likeCount: number, publishedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ likeCount, publishedAt, id })).toString('base64url');
}

export function decodeCursor(
  cursor?: string
): { likeCount: number; publishedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.likeCount !== 'number' ||
      !Number.isSafeInteger(record.likeCount) ||
      record.likeCount < 0 ||
      typeof record.publishedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(record.publishedAt) ||
      typeof record.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(record.id)
    ) {
      return null;
    }
    return { likeCount: record.likeCount, publishedAt: record.publishedAt, id: record.id };
  } catch {
    return null;
  }
}

export async function canAccessReference(
  mediaPlaza: ReturnType<typeof getDomainDb>,
  referenceId: string,
  userId: string
): Promise<boolean> {
  const { data: owned, error: ownedError } = await mediaPlaza
    .from('image_plaza_reference_assets')
    .select('id')
    .eq('id', referenceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (ownedError)
    throw new Error(`image plaza reference read failed: ${ownedError.message}`, {
      cause: ownedError,
    });
  if (owned) return true;

  const { data: publicWork, error: workError } = await mediaPlaza
    .from('image_plaza_works')
    .select('id')
    .contains('snapshot', { reference_artifact_id: referenceId })
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (workError)
    throw new Error(`image plaza reference access failed: ${workError.message}`, {
      cause: workError,
    });
  return Boolean(publicWork);
}
