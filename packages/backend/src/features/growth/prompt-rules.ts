import type { GrowthPromptKind } from '@miniapp/shared';

/**
 * 增长弹窗规则（产品决定，2026-11-13）：
 * - 进群：累计 13 轮；最多 2 次、间隔 ≥24h；领过奖、活动前成员、已在群里都不弹。
 * - VIP：累计 50 轮；最多 3 次、间隔 ≥3 天；有效 VIP 不弹；充过值/买过的用户只弹 1 次。
 * 轮数门槛交给前端判断时机，服务端负责前置条件与展示上限。
 */
export const PROMPT_AT_ROUNDS: Record<GrowthPromptKind, number> = { community: 13, vip: 50 };

const DAY_SECONDS = 24 * 60 * 60;

export interface PromptCap {
  maxShows: number;
  minIntervalSeconds: number;
}

export interface PromptState {
  shown_count: number;
  last_shown_at: string | null;
}

export function promptCap(kind: GrowthPromptKind, hasPaid: boolean): PromptCap {
  if (kind === 'community') return { maxShows: 2, minIntervalSeconds: DAY_SECONDS };
  return { maxShows: hasPaid ? 1 : 3, minIntervalSeconds: 3 * DAY_SECONDS };
}

export function canShowAgain(
  state: PromptState | undefined,
  cap: PromptCap,
  nowMs: number
): boolean {
  if (!state) return true;
  if (state.shown_count >= cap.maxShows) return false;
  if (!state.last_shown_at) return true;
  const last = Date.parse(state.last_shown_at);
  return !Number.isFinite(last) || nowMs - last >= cap.minIntervalSeconds * 1000;
}

export function isCommunityPromptEligible(input: {
  configured: boolean;
  claimed: boolean;
  excluded: boolean;
  inGroup: boolean;
}): boolean {
  return input.configured && !input.claimed && !input.excluded && !input.inGroup;
}

export function isVipPromptEligible(input: {
  purchaseEnabled: boolean;
  vipActive: boolean;
}): boolean {
  return input.purchaseEnabled && !input.vipActive;
}
