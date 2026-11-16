import type {
  ImageGenerationTier,
  ImageErrorCode,
  ImagePromptSource,
  MediaBillingMode,
  MessageImageAttempt,
  MessageImageStatus,
  WalletDebitPolicy,
} from '@miniapp/shared';

export type NumericValue = string | number;

export class ImageConflictError extends Error {
  constructor() {
    super('这条回复正在生成图片');
    this.name = 'ImageConflictError';
  }
}

export interface ChatMessageImageRow {
  id: string;
  user_id: string;
  session_id: string;
  message_id: string;
  attempt_no: number;
  /** 图片生成等级：basic、advanced */
  image_tier: ImageGenerationTier | null;
  prompt_cn: string | null;
  prompt_source: ImagePromptSource | null;
  description_user_prompt: string | null;
  prompt_en: string | null;
  provider_prompt: string | null;
  provider: string;
  model: string;
  base_url_host: string | null;
  width: number;
  height: number;
  output_format: string;
  price_credits: NumericValue;
  price_label: string;
  original_price_credits?: NumericValue | null;
  vip_discount_rate?: NumericValue | null;
  vip_discounted_exact?: NumericValue | null;
  vip_discount_config_version?: number | null;
  /** 计费模式：免费体验、付费 */
  billing_mode: MediaBillingMode | null;
  /** 免费体验次数：1、2、3 */
  free_trial_ordinal: number | null;
  /** 计费额度：星尘 */
  wallet_policy: WalletDebitPolicy | null;
  /** 会员有效期：时间戳 */
  vip_valid_until: string | null;
  status: ImageInternalStatus;
  is_current: boolean;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  stage: string | null;
  provider_request_id: string | null;
  storage_path: string | null;
  image_url: string | null;
  mime_type: 'image/webp' | 'image/png' | 'image/jpeg' | null;
  byte_size: number | null;
  latency_ms: number | null;
  error_code: ImageErrorCode | null;
  credits_charged: NumericValue;
  debit_ledger_id: string | null;
  charged_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ImageInternalStatus =
  | 'draft_describing'
  | 'draft_ready'
  | 'draft_failed'
  | 'pending'
  | 'leased'
  | 'generating'
  | 'storing'
  | 'ready'
  | 'failed'
  | 'failed_unknown';

export interface SettlementResult {
  charge_status?:
    | 'charged'
    | 'already_charged'
    | 'free_trial_consumed'
    | 'already_free_trial_consumed'
    | 'insufficient_balance'
    | 'free_trial_invalid';
  ledger_id?: string | null;
  required?: NumericValue;
  available?: NumericValue;
}

export function toMessageImageAttempt(row: ChatMessageImageRow): MessageImageAttempt {
  if (!row.prompt_cn || !row.prompt_source) throw new Error('图片 attempt 尚未进入可公开状态');
  return {
    id: row.id,
    message_id: row.message_id,
    attempt_no: row.attempt_no,
    tier: row.image_tier ?? 'basic',
    status: toPublicStatus(row.status),
    prompt_cn: row.prompt_cn,
    prompt_source: row.prompt_source,
    image_url: row.status === 'ready' ? row.image_url : null,
    width: row.width,
    height: row.height,
    mime_type: row.status === 'ready' ? row.mime_type : null,
    byte_size: row.status === 'ready' ? row.byte_size : null,
    error_code: row.status === 'failed' || row.status === 'failed_unknown' ? row.error_code : null,
    price_credits: toNumber(row.price_credits),
    price_label: row.price_label,
    credits_charged: toNumber(row.credits_charged),
    billing_mode: row.billing_mode ?? 'paid',
    /** 免费体验次数：1、2、3 */
    free_trial_ordinal: row.free_trial_ordinal ?? null,
    wallet_policy: row.wallet_policy ?? 'main_only',
    vip_valid_until: row.vip_valid_until ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

export function toPublicStatus(status: ImageInternalStatus): MessageImageStatus {
  if (status === 'draft_describing' || status === 'draft_ready' || status === 'draft_failed') {
    throw new Error('图片描述草稿状态不得进入公开 attempt');
  }
  if (status === 'leased' || status === 'storing') return 'generating';
  return status;
}

export function toNumber(value: NumericValue): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无效数值字段：${String(value)}`);
  return parsed;
}
