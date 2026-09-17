import { z } from 'zod';

/**
 * 聊天页角色图片生成。
 *
 * 图片是 assistant 回复的旁支产物：默认描述先创建 draft attempt，确认后推进为出图任务，
 * 成功图片固定绑定发起它的那条 message。
 */

/** 图片 prompt 的用户可见中文短文上限。前端提示和后端受理/送模型前校验共用。 */
export const MAX_IMAGE_PROMPT_CHARS = 200;

/** 用户确认图片生成时的输入来源。custom 不再进入默认分镜写稿链路。 */
export type ImagePromptSource = 'generated' | 'custom';

/**
 * 前端可见的 attempt 状态。
 *
 * 数据库内部的 leased 等调度状态不进入公开契约；UI 只关心是否还在生成、是否 ready、
 * 是否失败或结果未知。
 */
export type MessageImageStatus = 'pending' | 'generating' | 'ready' | 'failed' | 'failed_unknown';

/**
 * 图片生成失败码。前端按稳定业务码映射文案；provider/storage 细分错误仍只暴露脱敏前缀。
 */
export type ImageErrorCode =
  | 'image_disabled'
  | 'image_message_not_eligible'
  | 'image_session_not_found'
  | 'image_prompt_empty'
  | 'image_prompt_too_long'
  | 'image_character_visual_unavailable'
  | 'image_description_unusable'
  | 'image_description_timeout'
  | 'image_translation_failed'
  | 'image_insufficient_balance'
  | 'image_settlement_insufficient_balance'
  | 'image_generation_not_allowed'
  | 'image_attempt_conflict'
  | 'image_provider_timeout_unknown'
  | `image_provider_${string}`
  | `image_storage_${string}`;

export const ImagePromptSourceSchema = z.enum(['generated', 'custom']);
export const ImagePromptCnSchema = z.string().trim().min(1).max(MAX_IMAGE_PROMPT_CHARS);
export const CreateMessageImageRequestSchema = z.object({
  draft_id: z.string().uuid().optional(),
  prompt_cn: ImagePromptCnSchema,
  prompt_source: ImagePromptSourceSchema,
});

export interface ImageBillingConfig {
  /** image_generation_enabled。关闭时不创建新 attempt，已受理任务由后端继续收口。 */
  enabled: boolean;
  /** 单张成功图片扣费额，由后端 runtime config 下发，前端不得写死。 */
  credits_per_generation: number;
  /** 入口和确认按钮展示的价格文案。 */
  price_label: string;
}

export interface ImageLimitsConfig {
  /** 中文短文上限，当前等于 MAX_IMAGE_PROMPT_CHARS。 */
  max_prompt_chars: number;
  /** 生成图片宽度像素。 */
  width: number;
  /** 生成图片高度像素。 */
  height: number;
  /** 后端允许转存的最大图片字节数。 */
  max_output_bytes: number;
}

export interface ImageHintsConfig {
  /** 健康向控制提示，前端只展示简短说明，不参与模型 prompt。 */
  prompt_policy: string;
  prompt_over_limit: string;
  description_failed: string;
  generation_failed: string;
  failed_unknown: string;
}

export interface GetImageConfigData {
  enabled: boolean;
  billing: ImageBillingConfig;
  limits: ImageLimitsConfig;
  hints: ImageHintsConfig;
}

export interface MessageImageAttempt {
  id: string;
  message_id: string;
  attempt_no: number;
  status: MessageImageStatus;
  prompt_cn: string;
  prompt_source: ImagePromptSource;
  /** 仅 status = ready 时非空。 */
  image_url: string | null;
  width: number;
  height: number;
  mime_type: 'image/webp' | 'image/png' | 'image/jpeg' | null;
  byte_size: number | null;
  /** 失败态或模糊失败态用于 UI 文案；成功/生成中为 null。 */
  error_code: ImageErrorCode | null;
  /** 本 attempt 创建时锁定的价格。 */
  price_credits: number;
  /** 本 attempt 创建时锁定的展示价格文案。 */
  price_label: string;
  /** 成功实扣星尘；失败、未知失败和生成中为 0。 */
  credits_charged: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface MessageImageState {
  message_id: string;
  /** 当前展示版本：只会是 ready attempt；从未成功时为 null。 */
  current: MessageImageAttempt | null;
  /**
   * 最新一次 attempt：可能 pending/failed/ready。前端用它显示生成中或失败，
   * 同时不覆盖 current ready 图。
   */
  latest: MessageImageAttempt | null;
}

export interface GetSessionImagesData {
  images: MessageImageState[];
}

export interface CreateImageDescriptionData {
  draft_id: string;
  prompt_cn: string;
}

export type CreateMessageImageRequest = z.infer<typeof CreateMessageImageRequestSchema>;

export interface CreateMessageImageData {
  attempt: MessageImageAttempt;
}
