/**
 * 畅聊按身份开放（纯函数）：福利期所有人；福利期外按「新人试用 / 会员开通礼 / 会员每周畅聊日」。
 *
 * 时间一律按北京时间（UTC+8，无夏令时）算，直接加偏移，不引时区库。
 * 总开关 access.enabled 关着时只看福利期，结果与最初版本的栏目完全一致——这是关开关即回滚的前提。
 */
import type {
  FreeZoneAccessVia,
  FreeZoneAudience,
  FreeZoneConfig,
  FreeZoneVipWeekly,
  PublicFreeZoneAccess,
} from '@miniapp/shared';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
/** 试用/福利期结束多久以内还算「刚结束」，用来决定弹哪种 VIP 弹窗 */
export const RECENTLY_ENDED_MS = 7 * DAY_MS;
/** 读用户事实失败时临时放行多久（到点前端会重新拉目录） */
const DEGRADED_OPEN_MS = 30 * MINUTE_MS;

/** 判定要用到的用户事实；读失败时调用方传 null（按开放处理，见 evaluateFreeZoneAccess） */
export interface FreeZoneAccessFacts {
  /** 注册时间 */
  createdAt: string | null;
  vipValidUntil: string | null;
  /** 最近一次开通/续费 VIP 的时间 */
  lastVipGrantAt: string | null;
}

export interface TimeWindow {
  startsAt: number;
  endsAt: number;
}

export type FreeZoneAccessState =
  | { kind: 'hidden' }
  | { kind: 'not_started'; startsAt: number }
  | { kind: 'open'; via: FreeZoneAccessVia | null; endsAt: number }
  | { kind: 'vip_waiting'; startsAt: number }
  | { kind: 'vip_only'; vipDay: TimeWindow & { open: boolean } };

export interface FreeZoneAccessResult {
  state: FreeZoneAccessState;
  audience: FreeZoneAudience;
  /** 最近 7 天内刚结束的试用或福利期（取较晚的），给 VIP 弹窗选场景 */
  recentlyEnded: { reason: 'trial' | 'welfare'; at: number } | null;
  /** 正在新人试用期内（试用期不弹 VIP） */
  inTrial: boolean;
  vipActive: boolean;
  /** 前端写文案用；只有福利期的老配置也照样给 */
  publicAccess: PublicFreeZoneAccess;
  /** 用户事实读失败、临时放行 */
  degraded: boolean;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 包含 now 的那一次每周窗口（没有则 null），以及下一次。
 * 先找「最近一次已开始」的窗口：本周那天的开始时间若还没到，就退回上周。
 */
export function weeklyWindows(
  weekly: FreeZoneVipWeekly,
  nowMs: number
): { current: TimeWindow | null; next: TimeWindow } {
  const local = new Date(nowMs + BEIJING_OFFSET_MS);
  const isoWeekday = ((local.getUTCDay() + 6) % 7) + 1;
  const todayMidnight =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BEIJING_OFFSET_MS;
  const daysBack = (isoWeekday - weekly.weekday + 7) % 7;
  let startsAt = todayMidnight - daysBack * DAY_MS + weekly.start_minute * MINUTE_MS;
  if (startsAt > nowMs) startsAt -= WEEK_MS;
  const duration = weekly.duration_minutes * MINUTE_MS;
  const current = nowMs < startsAt + duration ? { startsAt, endsAt: startsAt + duration } : null;
  const nextStart = startsAt + WEEK_MS;
  return { current, next: { startsAt: nextStart, endsAt: nextStart + duration } };
}

export function evaluateFreeZoneAccess(input: {
  config: FreeZoneConfig;
  now: Date;
  /** null = 用户事实读失败 */
  facts: FreeZoneAccessFacts | null;
}): FreeZoneAccessResult {
  const { config } = input;
  const access = config.access;
  const nowMs = input.now.getTime();
  const periodStart = parseTime(config.period?.starts_at);
  const periodEnd = parseTime(config.period?.ends_at);
  const facts = input.facts;
  const vipUntil = parseTime(facts?.vipValidUntil);
  const vipActive = vipUntil !== null && vipUntil > nowMs;
  const createdAt = parseTime(facts?.createdAt);
  const trialSince = parseTime(access.trial_since);
  const trialEligible = createdAt !== null && trialSince !== null && createdAt >= trialSince;
  const trialEnd = trialEligible ? createdAt + access.trial_hours * HOUR_MS : null;
  const inTrial = access.enabled && trialEnd !== null && nowMs < trialEnd;

  const result = (
    state: FreeZoneAccessState,
    audience: FreeZoneAudience,
    extra: Partial<Pick<FreeZoneAccessResult, 'recentlyEnded' | 'degraded'>> = {}
  ): FreeZoneAccessResult => ({
    state,
    audience,
    recentlyEnded: extra.recentlyEnded ?? null,
    inTrial,
    vipActive,
    degraded: extra.degraded ?? false,
    publicAccess: {
      via: state.kind === 'open' ? state.via : null,
      audience,
      trial_hours: access.trial_hours,
      vip_welcome_days: access.vip_welcome_days,
      vip_weekly: { ...access.vip_weekly },
    },
  });

  if (!config.enabled) return result({ kind: 'hidden' }, 'everyone');
  if (periodStart !== null && periodEnd !== null && periodStart <= nowMs && nowMs < periodEnd) {
    return result({ kind: 'open', via: 'welfare', endsAt: periodEnd }, 'everyone');
  }
  if (!access.enabled) {
    return periodStart !== null && nowMs < periodStart
      ? result({ kind: 'not_started', startsAt: periodStart }, 'everyone')
      : result({ kind: 'hidden' }, 'everyone');
  }
  // 读不到用户事实：宁可多送一轮免费（每轮约几分钱），也不误扣会员的星尘。
  if (!facts) {
    return result({ kind: 'open', via: null, endsAt: nowMs + DEGRADED_OPEN_MS }, 'everyone', {
      degraded: true,
    });
  }

  const recentlyEnded = pickRecentlyEnded(
    [
      trialEnd !== null ? { reason: 'trial', at: trialEnd } : null,
      periodEnd !== null && createdAt !== null && createdAt < periodEnd
        ? { reason: 'welfare', at: periodEnd }
        : null,
    ],
    nowMs
  );

  const open: Array<{ via: FreeZoneAccessVia; endsAt: number }> = [];
  if (inTrial && trialEnd !== null) open.push({ via: 'trial', endsAt: trialEnd });
  const weekly = weeklyWindows(access.vip_weekly, nowMs);
  if (vipActive && vipUntil !== null) {
    const grantAt = parseTime(facts.lastVipGrantAt);
    if (grantAt !== null && access.vip_welcome_days > 0 && grantAt <= nowMs) {
      const welcomeEnd = Math.min(grantAt + access.vip_welcome_days * DAY_MS, vipUntil);
      if (nowMs < welcomeEnd) open.push({ via: 'vip_welcome', endsAt: welcomeEnd });
    }
    if (weekly.current) {
      open.push({ via: 'vip_weekly', endsAt: Math.min(weekly.current.endsAt, vipUntil) });
    }
  }
  const audience: FreeZoneAudience = inTrial ? 'trial' : vipActive ? 'vip' : 'non_vip';
  const latest = open.reduce<(typeof open)[number] | null>(
    (best, item) => (best === null || item.endsAt > best.endsAt ? item : best),
    null
  );
  if (latest) {
    return result({ kind: 'open', via: latest.via, endsAt: latest.endsAt }, audience, {
      recentlyEnded,
    });
  }
  if (vipActive && vipUntil !== null && weekly.next.startsAt < vipUntil) {
    return result({ kind: 'vip_waiting', startsAt: weekly.next.startsAt }, audience, {
      recentlyEnded,
    });
  }
  const vipDay = weekly.current
    ? { ...weekly.current, open: true }
    : { ...weekly.next, open: false };
  return result({ kind: 'vip_only', vipDay }, audience, { recentlyEnded });
}

function pickRecentlyEnded(
  items: Array<{ reason: 'trial' | 'welfare'; at: number } | null>,
  nowMs: number
): FreeZoneAccessResult['recentlyEnded'] {
  let best: FreeZoneAccessResult['recentlyEnded'] = null;
  for (const item of items) {
    if (!item || item.at > nowMs || nowMs - item.at >= RECENTLY_ENDED_MS) continue;
    if (!best || item.at > best.at) best = item;
  }
  return best;
}

/** 福利期外、开关开着时才需要读用户事实；其余情况判定结果与用户无关 */
export function needsAccessFacts(config: FreeZoneConfig, now: Date): boolean {
  if (!config.enabled || !config.access.enabled) return false;
  const start = parseTime(config.period?.starts_at);
  const end = parseTime(config.period?.ends_at);
  const nowMs = now.getTime();
  return !(start !== null && end !== null && start <= nowMs && nowMs < end);
}
