import { MAX_IMAGE_PROMPT_CHARS, type GetImageConfigData } from '@miniapp/shared';
import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';

const IMAGE_KEYS = [
  'image_generation_enabled',
  'image_generation_credits',
  'image_price_label',
  'image_default_art_style',
  'image_width',
  'image_height',
  'image_max_prompt_chars',
  'image_max_output_bytes',
  'image_prompt_policy',
  'image_prompt_over_limit_hint',
  'image_description_failed_hint',
  'image_generation_failed_hint',
  'image_failed_unknown_hint',
] as const;

export interface ImageRuntimeConfig {
  enabled: boolean;
  creditsPerGeneration: number;
  priceLabel: string;
  defaultArtStyle: string;
  width: number;
  height: number;
  maxPromptChars: number;
  maxOutputBytes: number;
  promptPolicy: string;
  promptOverLimitHint: string;
  descriptionFailedHint: string;
  generationFailedHint: string;
  failedUnknownHint: string;
}

/** 读取图片生成运营配置；缺失时仅回落到 migration 同款默认值，避免前端写死价格和限制。 */
export async function getImageRuntimeConfig(): Promise<ImageRuntimeConfig> {
  const entries = await fetchRuntimeConfigEntries(IMAGE_KEYS);
  return {
    enabled: readBoolean(entries.get('image_generation_enabled')?.value, false),
    creditsPerGeneration: readPositiveInteger(entries.get('image_generation_credits')?.value, 50),
    priceLabel: readString(entries.get('image_price_label')?.value, '50 星尘'),
    defaultArtStyle: readString(
      entries.get('image_default_art_style')?.value,
      '精致二次元竖幅插画，柔和光影，健康公开发布'
    ),
    width: readPositiveInteger(entries.get('image_width')?.value, 1024),
    height: readPositiveInteger(entries.get('image_height')?.value, 1536),
    maxPromptChars: readPositiveInteger(
      entries.get('image_max_prompt_chars')?.value,
      MAX_IMAGE_PROMPT_CHARS
    ),
    maxOutputBytes: readPositiveInteger(entries.get('image_max_output_bytes')?.value, 15728640),
    promptPolicy: readString(
      entries.get('image_prompt_policy')?.value,
      '仅生成健康向、可公开发布的单人/场景竖图，不包含露骨、暴力或未成年人性化内容。'
    ),
    promptOverLimitHint: readString(
      entries.get('image_prompt_over_limit_hint')?.value,
      '描述最多 200 字，请删减后再生成。'
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
  };
}

export function toImageConfigData(config: ImageRuntimeConfig): GetImageConfigData {
  return {
    enabled: config.enabled,
    billing: {
      enabled: config.enabled,
      credits_per_generation: config.creditsPerGeneration,
      price_label: config.priceLabel,
    },
    limits: {
      max_prompt_chars: config.maxPromptChars,
      width: config.width,
      height: config.height,
      max_output_bytes: config.maxOutputBytes,
    },
    hints: {
      prompt_policy: config.promptPolicy,
      prompt_over_limit: config.promptOverLimitHint,
      description_failed: config.descriptionFailedHint,
      generation_failed: config.generationFailedHint,
      failed_unknown: config.failedUnknownHint,
    },
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
