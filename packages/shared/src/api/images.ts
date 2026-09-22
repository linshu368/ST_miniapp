import { z } from 'zod';
import {
  ImageGenerationTierSchema,
  type FeatureFreeTrialQuotaView,
  type ImageGenerationTier,
} from './feature-free-trials.js';
import type { MediaBillingMode, MediaBillingPreview } from './voice.js';
import type { BillingGatingErrorCode, WalletDebitPolicy } from './wallet.js';
import type { VipEntitlementSummary } from './vip.js';

/**
 * 聊天页角色图片生成。
 *
 * 图片是 assistant 回复的旁支产物：默认描述先创建 draft attempt，确认后推进为出图任务，
 * 成功图片固定绑定发起它的那条 message。
 */

/** 图片 prompt 的用户可见中文短文上限。前端提示和后端受理/送模型前校验共用。 */
export const MAX_IMAGE_PROMPT_CHARS = 1000;

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
  | 'image_main_credits_insufficient'
  | 'image_vip_required'
  | 'image_advanced_unavailable'
  | 'image_free_trial_invalid'
  | 'image_settlement_insufficient_balance'
  | 'image_generation_not_allowed'
  | 'image_attempt_conflict'
  | 'image_provider_timeout_unknown'
  | `image_provider_${string}`
  | `image_storage_${string}`;

/**
 * 图片 prompt 来源
 * @returns 图片 prompt 来源
 */
export const ImagePromptSourceSchema = z.enum(['generated', 'custom']);
/**
 * 图片 prompt 中文
 * @returns 图片 prompt 中文
 */
export const ImagePromptCnSchema = z.string().trim().min(1).max(MAX_IMAGE_PROMPT_CHARS);
/**
 * 创建图片描述请求
 * @returns 创建图片描述请求
 */
export const CreateImageDescriptionRequestSchema = z.object({
  tier: ImageGenerationTierSchema.optional().default('basic'),
});
/**
 * 创建图片请求
 * @returns 创建图片请求
 */
export const CreateMessageImageRequestSchema = z.object({
  /** 草稿 ID */
  draft_id: z.string().uuid().optional(),
  /** 图片 prompt 中文 */
  prompt_cn: ImagePromptCnSchema,
  /** 图片 prompt 来源 */
  prompt_source: ImagePromptSourceSchema,
  /** 图片档位 */
  tier: ImageGenerationTierSchema.optional().default('basic'),
});

/**
 * 图片计费配置
 * @returns 图片计费配置
 */
export interface ImageBillingConfig {
  /** image_generation_enabled。关闭时不创建新 attempt，已受理任务由后端继续收口。 */
  enabled: boolean;
  /** 单张成功图片扣费额，由后端 runtime config 下发，前端不得写死。 */
  credits_per_generation: number;
  /** 入口和确认按钮展示的价格文案。 */
  price_label: string;
}

/**
 * 图片档位配置
 * @returns 图片档位配置
 */
export interface ImageTierConfig {
  /** 图片档位 */
  tier: ImageGenerationTier;
  /** 是否启用 */
  enabled: boolean;
  /** 是否可用 */
  available: boolean;
  /** 图片计费配置 */
  billing: ImageBillingConfig;
  /** 钱包扣费策略 */
  wallet_policy: WalletDebitPolicy;
  /** 是否需要 VIP */
  requires_vip: boolean;
  /** 免费体验额度 */
  free_trial: FeatureFreeTrialQuotaView | null;
  /** 下次计费 */
  next_billing: MediaBillingPreview;
  /** 锁定原因 */
  locked_reason: BillingGatingErrorCode | null;
}

/**
 * 图片限制配置
 * @returns 图片限制配置
 */
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

/**
 * 图片提示配置
 * @returns 图片提示配置
 */
export interface ImageHintsConfig {
  /** 健康向控制提示，前端只展示简短说明，不参与模型 prompt。 */
  prompt_policy: string;
  /** 提示超限 */
  prompt_over_limit: string;
  /** 描述失败 */
  description_failed: string;
  /** 生成失败 */
  generation_failed: string;
  /** 结果未知 */
  failed_unknown: string;
}

/**
 * 获取图片配置数据
 * @returns 获取图片配置数据
 */
export interface GetImageConfigData {
  /** 是否启用 */
  enabled: boolean;
  /** 图片计费配置 */
  billing: ImageBillingConfig;
  /** 图片档位配置 */
  tiers: {
    basic: ImageTierConfig;
    advanced: ImageTierConfig;
  };
  /** VIP 状态 */
  vip_status: VipEntitlementSummary;
  /** 图片限制配置 */
  limits: ImageLimitsConfig;
  /** 图片提示配置 */
  hints: ImageHintsConfig;
}

/**
 * 消息图片尝试
 * @returns 消息图片尝试
 */
export interface MessageImageAttempt {
  /** 图片尝试 ID */
  id: string;
  /** 消息 ID */
  message_id: string;
  /** 尝试编号 */
  attempt_no: number;
  /** 图片档位 */
  tier: ImageGenerationTier;
  /** 图片状态 */
  status: MessageImageStatus;
  /** 图片 prompt 中文 */
  prompt_cn: string;
  /** 图片 prompt 来源 */
  prompt_source: ImagePromptSource;
  /** 仅 status = ready 时非空。 */
  image_url: string | null;
  /** 图片宽度 */
  width: number;
  /** 图片高度 */
  height: number;
  /** 图片 MIME 类型 */
  mime_type: 'image/webp' | 'image/png' | 'image/jpeg' | null;
  /** 图片字节大小 */
  byte_size: number | null;
  /** 失败态或模糊失败态用于 UI 文案；成功/生成中为 null。 */
  error_code: ImageErrorCode | null;
  /** 本 attempt 创建时锁定的价格。 */
  price_credits: number;
  /** 本 attempt 创建时锁定的展示价格文案。 */
  price_label: string;
  /** 成功实扣星尘；失败、未知失败和生成中为 0。 */
  credits_charged: number;
  /** 计费模式 */
  billing_mode: MediaBillingMode;
  /** 免费体验次数 */
  free_trial_ordinal: number | null;
  /** 钱包扣费策略 */
  wallet_policy: WalletDebitPolicy;
  /** VIP 有效期 */
  vip_valid_until: string | null;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
  /** 完成时间 */
  completed_at: string | null;
}

/**
 * 消息图片状态
 * @returns 消息图片状态
 */
export interface MessageImageState {
  /** 消息 ID */
  message_id: string;
  /** 当前展示版本：只会是 ready attempt；从未成功时为 null。 */
  current: MessageImageAttempt | null;
  /**
   * 最新一次 attempt：可能 pending/failed/ready。前端用它显示生成中或失败，
   * 同时不覆盖 current ready 图。
   */
  latest: MessageImageAttempt | null;
}

/**
 * 获取会话图片数据
 * @returns 获取会话图片数据
 */
export interface GetSessionImagesData {
  /** 图片状态 */
  images: MessageImageState[];
}

/**
 * 创建图片描述数据
 * @returns 创建图片描述数据
 */
export interface CreateImageDescriptionData {
  /** 草稿 ID */
  draft_id: string;
  /** 图片 prompt 中文 */
  prompt_cn: string;
  /** 图片档位 */
  tier: ImageGenerationTier;
  /** 计费 */
  billing: MediaBillingPreview;
}

/**
 * 创建图片描述请求
 * @returns 创建图片描述请求
 */
export type CreateImageDescriptionRequest = z.infer<typeof CreateImageDescriptionRequestSchema>;

/**
 * 创建图片请求
 * @returns 创建图片请求
 */
export type CreateMessageImageRequest = z.infer<typeof CreateMessageImageRequestSchema>;

/**
 * 创建图片数据
 * @returns 创建图片数据
 */
export interface CreateMessageImageData {
  /** 图片尝试 */
  attempt: MessageImageAttempt;
}
