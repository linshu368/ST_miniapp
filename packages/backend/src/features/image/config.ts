import { MAX_IMAGE_PROMPT_CHARS, type GetImageConfigData } from '@miniapp/shared';
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
}

export interface ImageTextModelConfig {
  url: string;
  apiKey: string;
  model: string;
  source: 'runtime' | 'deepseek_default';
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
