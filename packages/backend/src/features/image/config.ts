import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMIT,
  MAX_IMAGE_PROMPT_CHARS,
  parseMediaFeatureFreeTrialLimit,
  type FeatureFreeTrialQuotaView,
  type GetImageConfigData,
  type ImageGenerationTier,
  type VipEntitlementSummary,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';
import { config } from '../../platform/config.js';
import { DEFAULT_IMAGE_DESCRIPTION_SYSTEM_PROMPT } from '../generation/image-upstream.js';

const IMAGE_KEYS = [
  'image_generation_enabled',
  'image_generation_credits',
  'image_price_label',
  'image_default_art_style',
  'image_description_system_prompt',
  'image_width',
  'image_height',
  'image_max_prompt_chars',
  'image_max_output_bytes',
  'image_prompt_policy',
  'image_prompt_over_limit_hint',
  'image_description_failed_hint',
  'image_generation_failed_hint',
  'image_failed_unknown_hint',
  'image_text_model_config',
  'image_advanced_enabled',
  'image_advanced_generation_credits',
  'image_advanced_price_label',
  'image_advanced_provider_config',
] as const;

export interface ImageRuntimeConfig {
  enabled: boolean;
  creditsPerGeneration: number;
  priceLabel: string;
  defaultArtStyle: string;
  descriptionSystemPrompt: string;
  width: number;
  height: number;
  maxPromptChars: number;
  maxOutputBytes: number;
  promptPolicy: string;
  promptOverLimitHint: string;
  descriptionFailedHint: string;
  generationFailedHint: string;
  failedUnknownHint: string;
  textModel: ImageTextModelConfig;
  advanced: AdvancedImageRuntimeConfig;
}

export interface ImageTextModelConfig {
  url: string;
  apiKey: string;
  model: string;
  source: 'runtime' | 'deepseek_default';
}

export interface AdvancedImageRuntimeConfig {
  enabled: boolean;
  creditsPerGeneration: number;
  priceLabel: string;
  provider: 'liaobots_grok' | 'replicate_z' | null;
  model: string | null;
  baseUrlHost: string | null;
}

/** 读取图片生成运营配置；缺失时仅回落到 migration 同款默认值，避免前端写死价格和限制。 */
export async function getImageRuntimeConfig(): Promise<ImageRuntimeConfig> {
  const entries = await fetchRuntimeConfigEntries(IMAGE_KEYS);
  return {
    enabled: readBoolean(entries.get('image_generation_enabled')?.value, false),
    creditsPerGeneration: readPositiveInteger(entries.get('image_generation_credits')?.value, 50),
    priceLabel: readString(entries.get('image_price_label')?.value, '50 星尘'),
    defaultArtStyle: readString(entries.get('image_default_art_style')?.value, ''),
    descriptionSystemPrompt: readString(
      entries.get('image_description_system_prompt')?.textValue,
      DEFAULT_IMAGE_DESCRIPTION_SYSTEM_PROMPT
    ),
    width: readPositiveInteger(entries.get('image_width')?.value, 1024),
    height: readPositiveInteger(entries.get('image_height')?.value, 1536),
    maxPromptChars: readPositiveInteger(
      entries.get('image_max_prompt_chars')?.value,
      MAX_IMAGE_PROMPT_CHARS
    ),
    maxOutputBytes: readPositiveInteger(entries.get('image_max_output_bytes')?.value, 15728640),
    promptPolicy: readString(entries.get('image_prompt_policy')?.value, ''),
    promptOverLimitHint: readString(
      entries.get('image_prompt_over_limit_hint')?.value,
      '描述最多 1000 字，请删减后再生成。'
    ),
    descriptionFailedHint: readString(
      entries.get('image_description_failed_hint')?.value,
      '这次没有写出合适的画面描述，请稍后重试。'
    ),
    generationFailedHint: readString(
      entries.get('image_generation_failed_hint')?.value,
      '图片生成没有成功，本次不消耗星尘。'
    ),
    failedUnknownHint: readString(
      entries.get('image_failed_unknown_hint')?.value,
      '本次没有消耗星尘。可以直接重试，或者把描述改一改再试。'
    ),
    textModel: resolveImageTextModelConfig(entries.get('image_text_model_config')?.value),
    advanced: resolveAdvancedImageRuntimeConfig({
      enabled: entries.get('image_advanced_enabled')?.value,
      credits: entries.get('image_advanced_generation_credits')?.value,
      priceLabel: entries.get('image_advanced_price_label')?.value,
      providerConfig: entries.get('image_advanced_provider_config')?.value,
    }),
  };
}

/** runtime 配置必须整组有效；任何字段缺失都回退当前 DeepSeek 三元组，避免混用 endpoint/key/model。 */
export function resolveImageTextModelConfig(value: unknown): ImageTextModelConfig {
  if (isRecord(value)) {
    const url = readHttpUrl(value.url);
    const apiKey = readBoundedString(value.api_key, 4096);
    const model = readBoundedString(value.model, 256);
    if (url && apiKey && model) return { url, apiKey, model, source: 'runtime' };
  }
  return {
    url: config.voice.draft.url,
    apiKey: config.voice.draft.apiKey,
    model: config.voice.draft.model,
    source: 'deepseek_default',
  };
}

export function toImageConfigData(config: ImageRuntimeConfig): GetImageConfigData {
  return toUserImageConfigData({
    config,
    basicFreeTrial: emptyBasicImageFreeTrialQuota(),
    vipStatus: {
      active: false,
      remaining_days: 0,
      valid_until: null,
    },
  });
}

export function toUserImageConfigData(input: {
  config: ImageRuntimeConfig;
  basicFreeTrial: FeatureFreeTrialQuotaView;
  vipStatus: VipEntitlementSummary;
}): GetImageConfigData {
  const { config: imageConfig, basicFreeTrial, vipStatus } = input;
  const basicProviderConfigured = Boolean(
    imageConfig.enabled &&
    config.image.liaobotsAuth &&
    config.image.liaobotsBase &&
    config.image.grokModel
  );
  const advancedConfigComplete = isAdvancedImageConfigured(imageConfig.advanced);
  const advancedLockedReason =
    !imageConfig.advanced.enabled || !advancedConfigComplete
      ? 'ADVANCED_IMAGE_UNAVAILABLE'
      : !vipStatus.active
        ? 'VIP_REQUIRED'
        : null;
  return {
    enabled: imageConfig.enabled,
    billing: {
      enabled: imageConfig.enabled,
      credits_per_generation: imageConfig.creditsPerGeneration,
      price_label: imageConfig.priceLabel,
    },
    tiers: {
      basic: {
        tier: 'basic',
        enabled: imageConfig.enabled,
        available: basicProviderConfigured,
        billing: {
          enabled: imageConfig.enabled,
          credits_per_generation: imageConfig.creditsPerGeneration,
          price_label: imageConfig.priceLabel,
        },
        wallet_policy: 'main_only',
        requires_vip: false,
        free_trial: basicFreeTrial,
        next_billing: {
          billing_mode: imageConfig.enabled
            ? basicFreeTrial.free_trials_remaining > 0
              ? 'free_trial'
              : 'paid'
            : 'legacy_free',
          wallet_policy: 'main_only',
          price_credits: imageConfig.creditsPerGeneration,
          price_label: imageConfig.priceLabel,
          free_trial_limit: basicFreeTrial.free_trial_limit,
          free_trial_ordinal: imageConfig.enabled ? basicFreeTrial.next_trial_ordinal : null,
          free_trials_remaining: imageConfig.enabled ? basicFreeTrial.free_trials_remaining : null,
        },
        locked_reason: null,
      },
      advanced: {
        tier: 'advanced',
        enabled: imageConfig.enabled && imageConfig.advanced.enabled,
        available: imageConfig.enabled && advancedLockedReason === null,
        billing: {
          enabled: imageConfig.enabled && imageConfig.advanced.enabled,
          credits_per_generation: imageConfig.advanced.creditsPerGeneration,
          price_label: imageConfig.advanced.priceLabel,
        },
        wallet_policy: 'main_only',
        requires_vip: true,
        free_trial: null,
        next_billing: {
          billing_mode: 'paid',
          wallet_policy: 'main_only',
          price_credits: imageConfig.advanced.creditsPerGeneration,
          price_label: imageConfig.advanced.priceLabel,
          free_trial_limit: null,
          free_trial_ordinal: null,
          free_trials_remaining: null,
        },
        locked_reason: imageConfig.enabled ? advancedLockedReason : 'ADVANCED_IMAGE_UNAVAILABLE',
      },
    },
    vip_status: vipStatus,
    limits: {
      max_prompt_chars: imageConfig.maxPromptChars,
      width: imageConfig.width,
      height: imageConfig.height,
      max_output_bytes: imageConfig.maxOutputBytes,
    },
    hints: {
      prompt_policy: imageConfig.promptPolicy,
      prompt_over_limit: imageConfig.promptOverLimitHint,
      description_failed: imageConfig.descriptionFailedHint,
      generation_failed: imageConfig.generationFailedHint,
      failed_unknown: imageConfig.failedUnknownHint,
    },
  };
}

export function getImageTierRuntimeConfig(
  imageConfig: ImageRuntimeConfig,
  tier: ImageGenerationTier
): {
  tier: ImageGenerationTier;
  creditsPerGeneration: number;
  priceLabel: string;
  provider: 'liaobots_grok' | 'replicate_z';
  model: string;
  baseUrlHost: string | null;
  width: number;
  height: number;
} | null {
  if (tier === 'basic') {
    if (
      !imageConfig.enabled ||
      !config.image.liaobotsAuth ||
      !config.image.liaobotsBase ||
      !config.image.grokModel
    ) {
      return null;
    }
    return {
      tier,
      creditsPerGeneration: imageConfig.creditsPerGeneration,
      priceLabel: imageConfig.priceLabel,
      provider: 'liaobots_grok',
      model: config.image.grokModel,
      baseUrlHost: readUrlHost(config.image.liaobotsBase),
      width: imageConfig.width,
      height: imageConfig.height,
    };
  }
  if (
    !imageConfig.enabled ||
    !imageConfig.advanced.enabled ||
    !isAdvancedImageConfigured(imageConfig.advanced)
  ) {
    return null;
  }
  return {
    tier,
    creditsPerGeneration: imageConfig.advanced.creditsPerGeneration,
    priceLabel: imageConfig.advanced.priceLabel,
    provider: imageConfig.advanced.provider,
    model: imageConfig.advanced.model,
    baseUrlHost: imageConfig.advanced.baseUrlHost,
    width: imageConfig.width,
    height: imageConfig.height,
  };
}

export function isAdvancedImageConfigured(
  value: AdvancedImageRuntimeConfig
): value is AdvancedImageRuntimeConfig & {
  provider: 'liaobots_grok' | 'replicate_z';
  model: string;
} {
  if (!value.provider || !value.model) return false;
  if (value.provider === 'liaobots_grok')
    return Boolean(config.image.liaobotsAuth && config.image.liaobotsBase);
  return Boolean(config.image.replicateToken && config.image.replicateBase);
}

export function emptyBasicImageFreeTrialQuota(): FeatureFreeTrialQuotaView {
  return emptyBasicImageFreeTrialQuotaForLimit(DEFAULT_FEATURE_FREE_TRIAL_LIMIT);
}

export function emptyBasicImageFreeTrialQuotaForLimit(
  limit = DEFAULT_FEATURE_FREE_TRIAL_LIMIT
): FeatureFreeTrialQuotaView {
  const resolvedLimit = parseMediaFeatureFreeTrialLimit(limit);
  return {
    feature: 'basic_image',
    free_trial_limit: resolvedLimit,
    free_trials_used: 0,
    free_trials_reserved: 0,
    free_trials_remaining: resolvedLimit,
    next_trial_ordinal: 1,
  };
}

function resolveAdvancedImageRuntimeConfig(input: {
  enabled: unknown;
  credits: unknown;
  priceLabel: unknown;
  providerConfig: unknown;
}): AdvancedImageRuntimeConfig {
  const providerConfig = isRecord(input.providerConfig) ? input.providerConfig : {};
  const provider = readProvider(providerConfig.provider);
  const model = readBoundedString(providerConfig.model, 256);
  const base = provider === 'replicate_z' ? config.image.replicateBase : config.image.liaobotsBase;
  return {
    enabled: readBoolean(input.enabled, false),
    creditsPerGeneration: readPositiveInteger(input.credits, 120),
    priceLabel: readString(input.priceLabel, '120 星尘'),
    provider,
    model,
    baseUrlHost: readUrlHost(base),
  };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function readHttpUrl(value: unknown): string | null {
  const text = readBoundedString(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

function readProvider(value: unknown): 'liaobots_grok' | 'replicate_z' | null {
  return value === 'liaobots_grok' || value === 'replicate_z' ? value : null;
}

function readUrlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
