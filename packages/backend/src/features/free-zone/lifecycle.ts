/**
 * 畅聊候选模型的上下架状态机（纯函数）。
 *
 * 三个状态：unlisted（未上架）→ listed（在架）→ cooling（刚下架、冷却中）→ unlisted。
 * - 未上架：官方数据初筛连续达标 N 次才上架（防单次快照碰巧好看、也防上上下下），
 *   上架时按 pickProvider 选定一家供应商。
 * - 在架：同一时刻只用一家供应商，选定后一直用（保缓存命中）。这家不行了——官方复核不达标，
 *   或真实业务数据越线——就用同一套规则顺延到下一家；所有达标供应商都用不了才下架。
 *   业务越线的那家会被排除一段时间，否则官方数据还说它好，又会被选回来。
 * - 冷却：官方原因固定时长；业务原因按 7 天内第几次被下架逐级拉长。
 * 数据拿不到（Surplus 接口失败、业务样本不足）时一律维持现状：不因为外部抖动清空栏目。
 */
import type { FreeZoneOnShelf, FreeZoneRelist } from '@miniapp/shared';
import { pickProvider, type ScreeningResult } from './screening.js';

export type FreeZoneModelStatus = 'unlisted' | 'listed' | 'cooling';

export interface FreeZoneModelState {
  candidateId: string;
  status: FreeZoneModelStatus;
  /** 当前在用的供应商（在架时恰好一家） */
  providers: string[];
  /** 当前供应商从什么时候开始用；业务指标只统计这之后的轮次 */
  providerSince: string | null;
  /** 因业务越线被排除的供应商 → 排除到期时间 */
  excludedProviders: Record<string, string>;
  consecutivePasses: number;
  cooldownUntil: string | null;
  /** 近 7 天因业务原因下架的时间点，用来算冷却梯度 */
  businessDelistsAt: string[];
  lastReason: string | null;
}

export interface BusinessMetrics {
  turns: number;
  noOutputPct: number | null;
  fallbackDeliveredPct: number | null;
  timeoutPct: number | null;
  ttftP90Ms: number | null;
  refusalPct: number | null;
  truncationPct: number | null;
  dislikePct: number | null;
}

export type BusinessVerdict =
  | { kind: 'pass' }
  | { kind: 'insufficient'; turns: number }
  | { kind: 'fail'; reasons: string[] };

type Cause = 'official' | 'business';

export type FreeZoneEvent =
  | { type: 'listed'; providers: string[]; manual?: boolean }
  | { type: 'provider_switched'; from: string; to: string; cause: Cause; reasons: string[] }
  | { type: 'delisted'; cause: Cause; reasons: string[]; cooldownUntil: string }
  | { type: 'cooldown_ended' };

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function initialState(candidateId: string): FreeZoneModelState {
  return {
    candidateId,
    status: 'unlisted',
    providers: [],
    providerSince: null,
    excludedProviders: {},
    consecutivePasses: 0,
    cooldownUntil: null,
    businessDelistsAt: [],
    lastReason: null,
  };
}

function exceeds(value: number | null, max: number | null, label: string): string | null {
  if (max === null || value === null) return null;
  return value > max ? `${label} ${Math.round(value * 10) / 10} > ${max}` : null;
}

/** 业务数据判定：样本不足不下结论；未知的单项不算越线（这一项没有数据可判）。 */
export function judgeBusinessMetrics(
  metrics: BusinessMetrics | null,
  rules: FreeZoneOnShelf
): BusinessVerdict {
  if (!metrics || metrics.turns < rules.min_turns) {
    return { kind: 'insufficient', turns: metrics?.turns ?? 0 };
  }
  const reasons = [
    exceeds(metrics.noOutputPct, rules.max_no_output_pct, '没出字率%'),
    exceeds(metrics.fallbackDeliveredPct, rules.max_fallback_delivered_pct, '兜底交付率%'),
    exceeds(metrics.timeoutPct, rules.max_timeout_pct, '超时率%'),
    exceeds(metrics.ttftP90Ms, rules.max_ttft_p90_ms, '真实首字p90'),
    exceeds(metrics.refusalPct, rules.max_refusal_pct, '拒答率%'),
    exceeds(metrics.truncationPct, rules.max_truncation_pct, '截断率%'),
    exceeds(metrics.dislikePct, rules.max_dislike_pct, '点踩率%'),
  ].filter((item): item is string => item !== null);
  return reasons.length > 0 ? { kind: 'fail', reasons } : { kind: 'pass' };
}

interface Step {
  state: FreeZoneModelState;
  now: Date;
  relist: FreeZoneRelist;
  ratio: number;
}

function minutesLater(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function activeExclusions(state: FreeZoneModelState, now: Date): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state.excludedProviders).filter(([, until]) => Date.parse(until) > now.getTime())
  );
}

function delist(
  { state, now, relist }: Step,
  cause: Cause,
  reasons: string[]
): { state: FreeZoneModelState; event: FreeZoneEvent } {
  const recent = state.businessDelistsAt.filter(
    (at) => now.getTime() - Date.parse(at) < SEVEN_DAYS_MS
  );
  const ladder = relist.cooldown_business_minutes;
  const minutes =
    cause === 'business'
      ? (ladder[Math.min(recent.length, ladder.length - 1)] ?? 0)
      : relist.cooldown_official_minutes;
  const cooldownUntil = minutesLater(now, minutes);
  return {
    state: {
      ...state,
      status: 'cooling',
      providers: [],
      providerSince: null,
      consecutivePasses: 0,
      cooldownUntil,
      businessDelistsAt: cause === 'business' ? [...recent, now.toISOString()] : recent,
      lastReason: reasons.join('；'),
    },
    event: { type: 'delisted', cause, reasons, cooldownUntil },
  };
}

/** 当前供应商用不了：顺延到下一家；一家都没有就下架。 */
function switchOrDelist(
  step: Step,
  screening: ScreeningResult | null,
  cause: Cause,
  reasons: string[]
): { state: FreeZoneModelState; event: FreeZoneEvent } {
  const { state, now } = step;
  const from = state.providers[0] ?? '';
  const excluded = new Set([...Object.keys(state.excludedProviders), from]);
  const next =
    screening?.pass === true
      ? pickProvider(screening.qualified, { excluded, ratio: step.ratio })
      : null;
  if (!next) return delist(step, cause, reasons);
  return {
    state: {
      ...state,
      providers: [next],
      providerSince: now.toISOString(),
      lastReason: `${from} → ${next}：${reasons.join('；')}`,
    },
    event: { type: 'provider_switched', from, to: next, cause, reasons },
  };
}

function screenUnlisted(
  step: Step,
  screening: ScreeningResult | null
): { state: FreeZoneModelState; event: FreeZoneEvent | null } {
  const { state, now, relist, ratio } = step;
  if (!screening) return { state, event: null };
  const excluded = new Set(Object.keys(state.excludedProviders));
  const provider = screening.pass ? pickProvider(screening.qualified, { excluded, ratio }) : null;
  if (!provider) {
    const reasons = screening.pass ? ['达标供应商都在排除期'] : screening.reasons;
    return {
      state: { ...state, consecutivePasses: 0, lastReason: reasons.join('；') || null },
      event: null,
    };
  }
  const passes = state.consecutivePasses + 1;
  if (passes < relist.required_passes) {
    return { state: { ...state, consecutivePasses: passes, lastReason: null }, event: null };
  }
  return {
    state: {
      ...state,
      status: 'listed',
      providers: [provider],
      providerSince: now.toISOString(),
      consecutivePasses: passes,
      cooldownUntil: null,
      lastReason: null,
    },
    event: { type: 'listed', providers: [provider] },
  };
}

function advanceListed(
  step: Step,
  screening: ScreeningResult | null,
  business: BusinessVerdict
): { state: FreeZoneModelState; events: FreeZoneEvent[] } {
  const { state, now, relist } = step;
  const current = state.providers[0];
  if (business.kind === 'fail' && current) {
    // 这家在我们自己的流量上不行：排除一段时间，再按规则顺延。
    const excludedProviders = {
      ...state.excludedProviders,
      [current]: minutesLater(now, relist.cooldown_business_minutes[0] ?? 0),
    };
    const next = switchOrDelist(
      { ...step, state: { ...state, excludedProviders } },
      screening,
      'business',
      business.reasons
    );
    return { state: next.state, events: [next.event] };
  }
  if (!screening) return { state, events: [] };
  const stillQualified =
    screening.pass && screening.qualified.some((item) => item.provider === current);
  if (stillQualified) return { state, events: [] };
  const reasons = screening.pass ? [`${current} 不再达标`] : screening.reasons;
  const next = switchOrDelist(step, screening, 'official', reasons);
  return { state: next.state, events: [next.event] };
}

/**
 * 运营手动上架：不管现在是未上架还是冷却中，直接用 provider 上架。连续达标数记满、冷却清掉，
 * 这家供应商的排除也解除（运营明确要用它）；7 天内的业务下架记录保留，再下架时冷却照样逐级拉长。
 * 之后的评估和普通在架模型一样：业务指标从现在重新累计，不达标照常换供应商或下架。
 */
export function listManually(input: {
  state: FreeZoneModelState;
  provider: string;
  now: Date;
  requiredPasses: number;
}): { state: FreeZoneModelState; event: FreeZoneEvent } {
  const { state, provider, now } = input;
  const excludedProviders = activeExclusions(state, now);
  delete excludedProviders[provider];
  return {
    state: {
      ...state,
      status: 'listed',
      providers: [provider],
      providerSince: now.toISOString(),
      excludedProviders,
      consecutivePasses: Math.max(state.consecutivePasses, input.requiredPasses),
      cooldownUntil: null,
      lastReason: null,
    },
    event: { type: 'listed', providers: [provider], manual: true },
  };
}

/**
 * 推进一个候选模型的状态。screening 为 null 表示这一轮官方数据缺失；
 * business 只对在架模型有意义（只统计当前供应商开始用之后的轮次）。
 */
export function advanceState(input: {
  state: FreeZoneModelState;
  now: Date;
  screening: ScreeningResult | null;
  business: BusinessVerdict;
  relist: FreeZoneRelist;
  priceBandRatio: number;
}): { state: FreeZoneModelState; events: FreeZoneEvent[] } {
  const { now, screening, business, relist } = input;
  let state = { ...input.state, excludedProviders: activeExclusions(input.state, now) };
  const events: FreeZoneEvent[] = [];
  const step = (s: FreeZoneModelState): Step => ({
    state: s,
    now,
    relist,
    ratio: input.priceBandRatio,
  });

  if (state.status === 'cooling') {
    if (state.cooldownUntil && now.getTime() < Date.parse(state.cooldownUntil)) {
      return { state, events };
    }
    state = { ...state, status: 'unlisted', consecutivePasses: 0, cooldownUntil: null };
    events.push({ type: 'cooldown_ended' });
  }

  if (state.status === 'unlisted') {
    const next = screenUnlisted(step(state), screening);
    if (next.event) events.push(next.event);
    return { state: next.state, events };
  }

  const next = advanceListed(step(state), screening, business);
  return { state: next.state, events: [...events, ...next.events] };
}
