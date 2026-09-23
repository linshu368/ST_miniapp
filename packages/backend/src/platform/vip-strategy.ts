/**
 * 已发布 VIP 策略的唯一读取入口。值来自 runtime-config，规则来自 shared schema。
 * 购买和提醒开关缺失或损坏时关闭；其余字段回退到与首次 seed 相同的默认值。
 */

import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  FEATURE_FREE_TRIAL_LIMITS_CONFIG_KEY,
  FeatureFreeTrialLimitsSchema,
  VIP_CHECKIN_BONUS_CONFIG_KEY,
  VIP_PLANS_CONFIG_KEY,
  VIP_PURCHASE_ENABLED_CONFIG_KEY,
  VIP_REMINDERS_ENABLED_CONFIG_KEY,
  VIP_TEXT_DISCOUNT_RATE_CONFIG_KEY,
  VipCheckinBonusConfigSchema,
  VipPlansConfigSchema,
  VipTextDiscountRateSchema,
  type FeatureFreeTrialLimits,
  type VipCheckinBonusConfig,
  type VipPlansConfig,
} from '@miniapp/shared';
import { createLogger } from '../lib/logger.js';
import { fetchRuntimeConfigEntries, type RuntimeConfigEntry } from './runtime-config.js';

const log = createLogger('vip-strategy');

const STRATEGY_KEYS = [
  VIP_PURCHASE_ENABLED_CONFIG_KEY,
  VIP_REMINDERS_ENABLED_CONFIG_KEY,
  VIP_PLANS_CONFIG_KEY,
  VIP_TEXT_DISCOUNT_RATE_CONFIG_KEY,
  VIP_CHECKIN_BONUS_CONFIG_KEY,
  FEATURE_FREE_TRIAL_LIMITS_CONFIG_KEY,
] as const;

export interface VipStrategyFallback {
  key: string;
  reason: 'missing' | 'invalid';
}

export interface VipStrategy {
  purchaseEnabled: boolean;
  remindersEnabled: boolean;
  plans: VipPlansConfig;
  plansVersion: number | null;
  discountRate: number;
  discountVersion: number | null;
  checkin: VipCheckinBonusConfig;
  checkinVersion: number | null;
  limits: FeatureFreeTrialLimits;
  limitsVersion: number | null;
  fallbacks: VipStrategyFallback[];
}

export function interpretVipStrategy(
  entries: ReadonlyMap<string, RuntimeConfigEntry>
): VipStrategy {
  const fallbacks: VipStrategyFallback[] = [];
  const purchase = readSwitch(
    entries.get(VIP_PURCHASE_ENABLED_CONFIG_KEY),
    VIP_PURCHASE_ENABLED_CONFIG_KEY,
    fallbacks
  );
  const reminders = readSwitch(
    entries.get(VIP_REMINDERS_ENABLED_CONFIG_KEY),
    VIP_REMINDERS_ENABLED_CONFIG_KEY,
    fallbacks
  );
  const plans = readValue(
    entries.get(VIP_PLANS_CONFIG_KEY),
    VIP_PLANS_CONFIG_KEY,
    VipPlansConfigSchema,
    DEFAULT_VIP_PLANS_CONFIG,
    fallbacks
  );
  const discount = readValue(
    entries.get(VIP_TEXT_DISCOUNT_RATE_CONFIG_KEY),
    VIP_TEXT_DISCOUNT_RATE_CONFIG_KEY,
    VipTextDiscountRateSchema,
    DEFAULT_VIP_TEXT_DISCOUNT_RATE,
    fallbacks
  );
  const checkin = readValue(
    entries.get(VIP_CHECKIN_BONUS_CONFIG_KEY),
    VIP_CHECKIN_BONUS_CONFIG_KEY,
    VipCheckinBonusConfigSchema,
    DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
    fallbacks
  );
  const limits = readValue(
    entries.get(FEATURE_FREE_TRIAL_LIMITS_CONFIG_KEY),
    FEATURE_FREE_TRIAL_LIMITS_CONFIG_KEY,
    FeatureFreeTrialLimitsSchema,
    DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
    fallbacks
  );

  return {
    purchaseEnabled: purchase.value,
    remindersEnabled: reminders.value,
    plans: plans.value,
    plansVersion: plans.version,
    discountRate: discount.value,
    discountVersion: discount.version,
    checkin: checkin.value,
    checkinVersion: checkin.version,
    limits: limits.value,
    limitsVersion: limits.version,
    fallbacks,
  };
}

export async function readVipStrategy(): Promise<VipStrategy> {
  const entries = await fetchRuntimeConfigEntries(STRATEGY_KEYS);
  const strategy = interpretVipStrategy(entries);
  for (const fallback of strategy.fallbacks) {
    log.sys.warn(
      { event: 'vip.strategy.fallback', key: fallback.key, reason: fallback.reason },
      'VIP策略配置缺失或损坏，已使用安全默认'
    );
  }
  return strategy;
}

function readSwitch(
  entry: RuntimeConfigEntry | undefined,
  key: string,
  fallbacks: VipStrategyFallback[]
): { value: boolean } {
  if (!entry) {
    fallbacks.push({ key, reason: 'missing' });
    return { value: false };
  }
  if (entry.value !== true && entry.value !== false) {
    fallbacks.push({ key, reason: 'invalid' });
    return { value: false };
  }
  return { value: entry.value };
}

function readValue<T>(
  entry: RuntimeConfigEntry | undefined,
  key: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  fallback: T,
  fallbacks: VipStrategyFallback[]
): { value: T; version: number | null } {
  if (!entry) {
    fallbacks.push({ key, reason: 'missing' });
    return { value: structuredClone(fallback), version: null };
  }
  const parsed = schema.safeParse(entry.value);
  if (!parsed.success) {
    fallbacks.push({ key, reason: 'invalid' });
    return { value: structuredClone(fallback), version: null };
  }
  return { value: parsed.data, version: entry.version };
}
