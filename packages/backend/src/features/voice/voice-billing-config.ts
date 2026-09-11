/**
 * backend / features / voice / voice-billing-config.ts
 *
 * 语音计费与文案配置的统一读取入口。七个键都在 miniapp.runtime_config，
 * 由 migration 097 种入。读取范式对齐 features/billing/free-quota.ts：
 * 直读 runtime_config，缺失/损坏时降级到内置兜底并打 warn，不另起第二套读法
 * （架构铁律 7：runtime_config 只有一个读取入口 platform/runtime-config.ts）。
 */

import {
  MAX_SPOKEN_VOICE_CHARS,
  type VoiceBillingConfig,
  type VoiceHintsConfig,
  type VoiceLimitsConfig,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';

export const VOICE_BILLING_ENABLED_KEY = 'voice_billing_enabled';
export const VOICE_GENERATION_CREDITS_KEY = 'voice_generation_credits';
export const VOICE_MAX_SPOKEN_CHARS_KEY = 'voice_max_spoken_chars';
export const VOICE_PRICE_LABEL_KEY = 'voice_price_label';
export const VOICE_OVER_LIMIT_HINT_KEY = 'voice_over_limit_hint';
export const VOICE_DRAFT_FAILED_HINT_KEY = 'voice_draft_failed_hint';
export const VOICE_TTS_FAILED_HINT_KEY = 'voice_tts_failed_hint';

/** 兜底值：与 migration 097 的 seed 逐项等值，配置缺失/损坏时用这套。 */
export const DEFAULT_VOICE_BILLING_CONFIG = {
  enabled: false,
  creditsPerGeneration: 15,
  maxSpokenChars: MAX_SPOKEN_VOICE_CHARS,
  priceLabel: '15 星尘',
  overLimitHint: '文字处理后的语音文本超过 300 字，请删减或缩改后再生成',
  draftFailedHint: '本次未生成，请稍后重试',
  ttsFailedHint: '语音生成失败，请重试',
} as const;

export interface VoiceBillingRuntimeConfig {
  billing: VoiceBillingConfig;
  limits: VoiceLimitsConfig;
  hints: VoiceHintsConfig;
  /** 拍平后的便捷字段，后端流程直接用，不必每次再从 billing/limits 解包 */
  enabled: boolean;
  creditsPerGeneration: number;
  maxSpokenChars: number;
  priceLabel: string;
  overLimitHint: string;
  draftFailedHint: string;
  ttsFailedHint: string;
}

const VOICE_CONFIG_KEYS = [
  VOICE_BILLING_ENABLED_KEY,
  VOICE_GENERATION_CREDITS_KEY,
  VOICE_MAX_SPOKEN_CHARS_KEY,
  VOICE_PRICE_LABEL_KEY,
  VOICE_OVER_LIMIT_HINT_KEY,
  VOICE_DRAFT_FAILED_HINT_KEY,
  VOICE_TTS_FAILED_HINT_KEY,
] as const;

function readBoolean(entry: unknown, fallback: boolean): boolean {
  const value = (entry as { value?: unknown } | null)?.value;
  return typeof value === 'boolean' ? value : fallback;
}

function readPositiveInteger(entry: unknown, fallback: number): number {
  const value = (entry as { value?: unknown } | null)?.value;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readNonEmptyString(entry: unknown, fallback: string): string {
  const value = (entry as { value?: unknown } | null)?.value;
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/**
 * 一次取齐七个键。热路径（受理预检 + 后台生成）都要它，逐个查会多六个往返。
 * 缺失的键不出现在 Map 里，各自回落到 DEFAULT。
 */
export async function getVoiceBillingConfig(): Promise<VoiceBillingRuntimeConfig> {
  const entries = await fetchRuntimeConfigEntries(VOICE_CONFIG_KEYS);

  const enabled = readBoolean(
    entries.get(VOICE_BILLING_ENABLED_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.enabled
  );
  const creditsPerGeneration = readPositiveInteger(
    entries.get(VOICE_GENERATION_CREDITS_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.creditsPerGeneration
  );
  const maxSpokenChars = readPositiveInteger(
    entries.get(VOICE_MAX_SPOKEN_CHARS_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.maxSpokenChars
  );
  const priceLabel = readNonEmptyString(
    entries.get(VOICE_PRICE_LABEL_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.priceLabel
  );
  const overLimitHint = readNonEmptyString(
    entries.get(VOICE_OVER_LIMIT_HINT_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.overLimitHint
  );
  const draftFailedHint = readNonEmptyString(
    entries.get(VOICE_DRAFT_FAILED_HINT_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.draftFailedHint
  );
  const ttsFailedHint = readNonEmptyString(
    entries.get(VOICE_TTS_FAILED_HINT_KEY),
    DEFAULT_VOICE_BILLING_CONFIG.ttsFailedHint
  );

  return {
    billing: {
      enabled,
      credits_per_generation: creditsPerGeneration,
      price_label: priceLabel,
    },
    limits: { max_spoken_chars: maxSpokenChars },
    hints: {
      over_limit: overLimitHint,
      draft_failed: draftFailedHint,
      tts_failed: ttsFailedHint,
    },
    enabled,
    creditsPerGeneration,
    maxSpokenChars,
    priceLabel,
    overLimitHint,
    draftFailedHint,
    ttsFailedHint,
  };
}
