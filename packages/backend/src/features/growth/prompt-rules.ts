import type { GrowthPromptKind, VipPromptContext } from '@miniapp/shared';
import type { FreeZoneAccessResult } from '../free-zone/access.js';

/**
 * 增长弹窗规则：
 * - 进群（2026-11-13）：累计 13 轮；最多 2 次、间隔 ≥24h；领过奖、活动前成员、已在群里都不弹。
 * - VIP（2026-11-17 改，跟着畅聊按身份开放走）：会员期间、新人试用期内不弹；
 *   新人试用/福利期刚结束 → 完成被切到付费的那一轮后弹；会员畅聊日开放中 → 非会员打开就弹。
 *   频次：两次至少隔 min_interval_days 天，每弹满 batch_size 次停 batch_cooldown_days 天
 *   （任意 batch_cooldown_days 天内不超过 batch_size 次），参数在 free_zone_config.access.prompt。
 *   原「累计 50 轮」与「充过值只弹 1 次」不再使用；展示记录沿用 prompt='vip' 那一行。
 * 轮数门槛交给前端判断时机，服务端负责前置条件与展示上限。
 */
export const PROMPT_AT_ROUNDS: Record<'community', number> = { community: 13 };

const DAY_SECONDS = 24 * 60 * 60;

export interface PromptCap {
  maxShows: number;
  minIntervalSeconds: number;
}

export interface PromptState {
  shown_count: number;
  last_shown_at: string | null;
}

export interface VipPromptFrequency {
  min_interval_days: number;
  batch_size: number;
  batch_cooldown_days: number;
}

/** 数据库函数参数是 int4，上限不能超过它 */
const PG_INT_MAX = 2_147_483_647;

/** 进群的上限；VIP 的 accepted/dismissed 也用它（这两种事件不看上限） */
export function promptCap(kind: GrowthPromptKind): PromptCap {
  if (kind === 'community') return { maxShows: 2, minIntervalSeconds: DAY_SECONDS };
  return { maxShows: PG_INT_MAX, minIntervalSeconds: 0 };
}

/**
 * VIP 弹窗这一次的上限。数据库函数只认「总次数 < 上限 且 过了间隔」，
 * 所以上限传「当前次数 + 1」：既只放行一次（多设备同时弹只有一个成功），又能按批次换间隔。
 */
export function vipPromptCap(
  state: PromptState | undefined,
  frequency: VipPromptFrequency
): PromptCap {
  const shown = state?.shown_count ?? 0;
  const cooling = shown > 0 && shown % frequency.batch_size === 0;
  const days = cooling ? frequency.batch_cooldown_days : frequency.min_interval_days;
  return { maxShows: shown + 1, minIntervalSeconds: days * DAY_SECONDS };
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

/**
 * VIP 弹窗此刻该用哪个场景；null 表示不弹。会员与试用期内不弹。
 * 「刚结束」类每次结束只弹一次：结束之后已经弹过（last_shown_at 晚于结束时间）就不再用这个场景。
 */
export function pickVipPromptContext(input: {
  purchaseEnabled: boolean;
  access: FreeZoneAccessResult;
  state: PromptState | undefined;
}): { context: VipPromptContext; afterNextRound: boolean } | null {
  const { access } = input;
  if (!input.purchaseEnabled || access.vipActive || access.inTrial) return null;
  const ended = access.recentlyEnded;
  const lastShown = input.state?.last_shown_at ? Date.parse(input.state.last_shown_at) : null;
  if (ended && (lastShown === null || !Number.isFinite(lastShown) || lastShown < ended.at)) {
    return {
      context: ended.reason === 'trial' ? 'trial_ended' : 'welfare_ended',
      afterNextRound: true,
    };
  }
  if (access.state.kind === 'vip_only' && access.state.vipDay.open) {
    return { context: 'vip_day', afterNextRound: false };
  }
  return null;
}
