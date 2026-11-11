/**
 * 畅聊栏目的对外状态与自动换模型（纯函数）。
 *
 * 栏目状态只由后端按「用户 + 角色卡 + 当前时间」算出，前端不判断规则：
 * 开放规则会分阶段变化（整周免费 → 每周时段 → 限定范围），这样改规则不用改前端。
 */
import type {
  FixedDeductionConfig,
  FreeZoneCandidate,
  FreeZoneConfig,
  ModelCatalogTierKey,
  PublicFreeZone,
} from '@miniapp/shared';

export interface ListedFreeModel {
  candidate: FreeZoneCandidate;
  providers: string[];
}

function originalCredits(tier: ModelCatalogTierKey, pricing: FixedDeductionConfig): number {
  return Math.max(0, Math.round(pricing[tier]));
}

/** 返回 null 表示栏目不显示（总开关关、没配福利期、福利期已结束）。 */
export function resolveFreeZoneView(input: {
  config: FreeZoneConfig;
  listed: ListedFreeModel[];
  now: Date;
  isOwnCard: boolean;
  pricing: FixedDeductionConfig;
}): PublicFreeZone | null {
  const { config, listed, now } = input;
  if (!config.enabled || !config.period) return null;
  const startsAt = Date.parse(config.period.starts_at);
  const endsAt = Date.parse(config.period.ends_at);
  if (now.getTime() >= endsAt) return null;

  const base = {
    rules: config.rules_text,
    models: listed.map(({ candidate }) => ({
      id: candidate.id,
      display_name: candidate.display_name,
      tagline: candidate.tagline,
      benchmark_tier: candidate.benchmark_tier,
      original_credits: originalCredits(candidate.benchmark_tier, input.pricing),
    })),
  };
  if (now.getTime() < startsAt) {
    return { state: 'not_started', starts_at: config.period.starts_at, ...base };
  }
  if (listed.length === 0) return { state: 'no_models', ...base };
  if (config.scope === 'own_cards' && !input.isOwnCard) {
    return { state: 'own_card_only', ...base };
  }
  return { state: 'open', ends_at: config.period.ends_at, ...base };
}

/**
 * 选中的免费模型不能用时换成谁：同系列的在架模型优先，其次随机一个在架模型；
 * 栏目不开放或一个都不剩时返回 null，由调用方换回兜底模型（1017）。
 */
export function chooseReplacement(input: {
  currentFamily: string | null;
  usable: ListedFreeModel[];
  random?: () => number;
}): FreeZoneCandidate | null {
  if (input.usable.length === 0) return null;
  const family = input.currentFamily?.toLowerCase() ?? null;
  const sameFamily = family
    ? input.usable.filter(({ candidate }) => candidate.family.toLowerCase() === family)
    : [];
  const pool = sameFamily.length > 0 ? sameFamily : input.usable;
  const random = input.random ?? Math.random;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index]?.candidate ?? null;
}
