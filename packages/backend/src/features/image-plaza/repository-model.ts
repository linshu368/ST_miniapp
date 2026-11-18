import {
  ImagePlazaSnapshotSchema,
  VideoPlazaSnapshotSchema,
  type ImagePlazaArtifact,
  type ImagePlazaAttempt,
  type ImagePlazaConversation,
  type ProviderImagePlazaModel,
  type VideoPlazaAttempt,
} from '@miniapp/shared';
import { Buffer } from 'node:buffer';
import { getDomainDb } from '../../lib/supabase.js';
import { signPrivateVideoPath } from './storage.js';
import { signPlazaStreamPlayback } from './video-stream-playback.js';

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
  user_id: string | null;
  attempt_id: string | null;
  artifact_id: string | null;
  media_type?: 'image' | 'video';
  video_artifact_id?: string | null;
  video_attempt_id?: string | null;
  duration_ms?: number | null;
  description?: string;
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

export interface VideoArtifactRow {
  id: string;
  attempt_id: string | null;
  stream_uid: string;
  playback_url: string;
  poster_path: string | null;
  width: number;
  height: number;
  duration_ms: number;
}

export interface VideoConversationAttemptRow {
  id: string;
  conversation_id: string;
  assistant_message_id: string;
  status: VideoPlazaAttempt['status'];
  error_code: string | null;
  quote_credits: number;
  model_id: string;
  input_mode: 't2v' | 'i2v' | 'r2v';
  duration_s: number;
  resolution: string;
  aspect_ratio: string | null;
  audio: boolean;
  reference_artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export const WORK_COLUMNS =
  'id,user_id,attempt_id,artifact_id,title,model_id,model_name,width,height,tags,snapshot,like_count,published_at,deleted_at,initial_feed_order::text,media_type,video_artifact_id,video_attempt_id,duration_ms,description';

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
  media_type?: 'image' | 'video';
  video_attempt_id?: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string;
  source_work_id?: string | null;
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

export async function mapVideoConversationAttempt(
  row: VideoConversationAttemptRow,
  artifact: VideoArtifactRow | null
): Promise<VideoPlazaAttempt> {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    status: row.status,
    error_code: row.error_code,
    quote_credits: Number(row.quote_credits),
    params: {
      model_id: row.model_id,
      input_mode: row.input_mode,
      duration_s: row.duration_s,
      resolution: row.resolution,
      aspect_ratio: row.aspect_ratio,
      audio: row.audio,
      reference_artifact_id: row.reference_artifact_id,
    },
    artifact: artifact
      ? {
          id: artifact.id,
          playback: await signPlazaStreamPlayback(artifact.stream_uid),
          poster_url: artifact.poster_path
            ? await signPrivateVideoPath(artifact.poster_path)
            : null,
          width: artifact.width,
          height: artifact.height,
          duration_ms: artifact.duration_ms,
        }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mapConversationRow(
  row: ConversationRow,
  messages: Array<
    MessageRow & {
      attempt?: ImagePlazaAttempt | null;
      videoAttempt?: VideoPlazaAttempt | null;
    }
  >
): ImagePlazaConversation {
  const snapshot =
    row.snapshot === null
      ? null
      : ImagePlazaSnapshotSchema.safeParse(row.snapshot).success
        ? ImagePlazaSnapshotSchema.parse(row.snapshot)
        : VideoPlazaSnapshotSchema.parse(row.snapshot);
  return {
    id: row.id,
    title: row.title,
    source_work_id: row.source_work_id ?? null,
    snapshot,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      media_type: message.media_type ?? 'image',
      attempt: message.attempt ?? null,
      video_attempt: message.videoAttempt ?? null,
      created_at: message.created_at,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** ILIKE 通配符与 PostgREST 过滤分隔符需转义，避免用户输入扩大或破坏过滤条件。 */
export function escapeIlikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** PostgREST `.or()` 值含逗号/点号等时需双引号包裹，并转义内部引号与反斜杠。 */
export function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function promptZhTagFilter(labels: string[] | undefined): string | null {
  const terms = [
    ...new Set(
      (labels ?? []).map((label) => escapeIlikePattern(label.trim().slice(0, 80))).filter(Boolean)
    ),
  ];
  if (terms.length === 0) return null;
  return terms
    .map((term) => `snapshot->>prompt_zh.ilike.${quotePostgrestFilterValue(`%${term}%`)}`)
    .join(',');
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
