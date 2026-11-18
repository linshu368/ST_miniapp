/**
 * 畅聊候选模型的上下架状态机（纯函数），每 30 分钟评估一轮推进一次。
 *
 * 三个状态：unlisted（未上架）→ listed（在架）→ cooling（下架后冷却或停用）→ unlisted。
 * - 未上架：这一轮官方初筛（含派单探测）通过就上架，按 pickProvider 选定一家供应商。
 * - 在架：同一时刻只用一家供应商，选定后一直用（保缓存命中）。下架分两类原因：
 *   - 价格原因（多半是暂时的）：这家不再达标（报价没了、探测派不出去）就按同一套规则换到下一家，
 *     都不行才下架；冷却 price_cooldown_minutes 后照常评估，报价回来就重新上架。
 *     真实请求派不出去的当场下架（unroutable-guard.ts）也走这条。
 *   - 质量原因（不可接受）：最近的真实轮次里中断率或不可用率越线，直接下架并停着（同手动下架），
 *     运营「立即上架」才回来。换供应商不一定能解决，也不自动重试。
 * 数据拿不到（Surplus 接口失败、质量样本不足）时一律维持现状：不因为外部抖动清空栏目。
 */
import type { FreeZoneOnShelf, FreeZoneRelist } from '@miniapp/shared';
import { QUALITY_MIN_TURNS } from '@miniapp/shared';
import { pickProvider, type ScreeningResult } from './screening.js';

export type FreeZoneModelStatus = 'unlisted' | 'listed' | 'cooling';

export interface FreeZoneModelState {
  candidateId: string;
  status: FreeZoneModelStatus;
  /** 当前在用的供应商（在架时恰好一家） */
  providers: string[];
  /** 当前供应商从什么时候开始用；质量指标只统计这之后的轮次 */
  providerSince: string | null;
  cooldownUntil: string | null;
  lastReason: string | null;
  /**
   * 以下三项是旧机制（业务越线排除供应商、连续达标次数、业务冷却梯度）的列，已停用：
   * 状态推进不再读写，落库时原样带回。
   */
  excludedProviders: Record<string, string>;
  consecutivePasses: number;
  businessDelistsAt: string[];
}

/** 在架模型过去 3 小时（这次上架之后）的真实轮次里的两项质量指标 */
export interface QualityMetrics {
  turns: number;
  /** 不可用率：超时兜底 + 超时，占全部轮次 */
  unusablePct: number | null;
  /** 中断率：开始出字后没写完就断，占免费模型自己交付的轮次；交付轮次太少时为 null */
  interruptedPct: number | null;
}

export type QualityVerdict =
  | { kind: 'pass' }
  | { kind: 'insufficient'; turns: number }
  | { kind: 'fail'; reasons: string[] };

/** official：价格原因（冷却后自动回来）；business：质量原因（停着等运营上架） */
type Cause = 'official' | 'business';

export type FreeZoneEvent =
  | { type: 'listed'; providers: string[]; manual?: boolean }
  | { type: 'provider_switched'; from: string; to: string; cause: Cause; reasons: string[] }
  /** cause 为 null 表示运营手动下架 */
  | { type: 'delisted'; cause: Cause | null; reasons: string[]; cooldownUntil: string }
  | { type: 'cooldown_ended' };

type Transition = { state: FreeZoneModelState; event: FreeZoneEvent };

/** 停用的冷却截止：远到评估任务永远不会自动把它加回来，只能走「立即上架」。 */
export const MANUAL_HOLD_UNTIL = '2100-01-01T00:00:00.000Z';
export const MANUAL_DELIST_REASON = '运营手动下架';
const HOLD_HINT = '点「立即上架」才会回来';
const COOLDOWN_SLACK_MS = 5 * 60_000;

/** 冷却 5 分钟内到期的也算到期：评估 30 分钟一轮，差几秒没到期就会白等一轮 */
export function stillCooling(state: FreeZoneModelState, now: Date): boolean {
  return (
    state.status === 'cooling' &&
    state.cooldownUntil !== null &&
    now.getTime() + COOLDOWN_SLACK_MS < Date.parse(state.cooldownUntil)
  );
}

export function initialState(candidateId: string): FreeZoneModelState {
  return {
    candidateId,
    status: 'unlisted',
    providers: [],
    providerSince: null,
    cooldownUntil: null,
    lastReason: null,
    excludedProviders: {},
    consecutivePasses: 0,
    businessDelistsAt: [],
  };
}

function exceeds(value: number | null, max: number | null, label: string): string | null {
  if (max === null || value === null) return null;
  return value > max ? `${label} ${Math.round(value * 10) / 10} > ${max}` : null;
}

/** 质量判定：样本不足不下结论；某项没有数据就不判这一项。 */
export function judgeQuality(
  metrics: QualityMetrics | null,
  rules: Pick<FreeZoneOnShelf, 'max_interrupted_pct' | 'max_unusable_pct'>
): QualityVerdict {
  if (!metrics || metrics.turns < QUALITY_MIN_TURNS) {
    return { kind: 'insufficient', turns: metrics?.turns ?? 0 };
  }
  const reasons = [
    exceeds(metrics.interruptedPct, rules.max_interrupted_pct, '中断率%'),
    exceeds(metrics.unusablePct, rules.max_unusable_pct, '不可用率%'),
  ].filter((item): item is string => item !== null);
  return reasons.length > 0 ? { kind: 'fail', reasons } : { kind: 'pass' };
}

function cooling(
  state: FreeZoneModelState,
  cooldownUntil: string,
  lastReason: string
): FreeZoneModelState {
  return {
    ...state,
    status: 'cooling',
    providers: [],
    providerSince: null,
    cooldownUntil,
    lastReason,
  };
}

/** 价格原因下架：冷却一段时间后照常评估 */
function delistForPrice(
  state: FreeZoneModelState,
  now: Date,
  relist: FreeZoneRelist,
  reasons: string[]
): Transition {
  const cooldownUntil = new Date(
    now.getTime() + relist.price_cooldown_minutes * 60_000
  ).toISOString();
  return {
    state: cooling(state, cooldownUntil, reasons.join('；')),
    event: { type: 'delisted', cause: 'official', reasons, cooldownUntil },
  };
}

/** 质量原因下架：停着，同手动下架 */
function delistForQuality(state: FreeZoneModelState, reasons: string[]): Transition {
  return {
    state: cooling(state, MANUAL_HOLD_UNTIL, `${reasons.join('；')}：${HOLD_HINT}`),
    event: { type: 'delisted', cause: 'business', reasons, cooldownUntil: MANUAL_HOLD_UNTIL },
  };
}

interface Step {
  state: FreeZoneModelState;
  now: Date;
  relist: FreeZoneRelist;
  ratio: number;
}

/** 当前供应商不再达标：顺延到下一家；一家都没有就按价格原因下架。 */
function switchOrDelist(
  step: Step,
  screening: ScreeningResult | null,
  reasons: string[]
): Transition {
  const { state, now } = step;
  const from = state.providers[0] ?? '';
  const next =
    screening?.pass === true
      ? pickProvider(screening.qualified, { excluded: new Set([from]), ratio: step.ratio })
      : null;
  if (!next) return delistForPrice(state, now, step.relist, reasons);
  return {
    state: {
      ...state,
      providers: [next],
      providerSince: now.toISOString(),
      lastReason: `${from} → ${next}：${reasons.join('；')}`,
    },
    event: { type: 'provider_switched', from, to: next, cause: 'official', reasons },
  };
}

function screenUnlisted(
  { state, now, ratio }: Step,
  screening: ScreeningResult | null
): { state: FreeZoneModelState; event: FreeZoneEvent | null } {
  if (!screening) return { state, event: null };
  const provider = screening.pass ? pickProvider(screening.qualified, { ratio }) : null;
  if (!provider)
    return { state: { ...state, lastReason: screening.reasons.join('；') || null }, event: null };
  return {
    state: {
      ...state,
      status: 'listed',
      providers: [provider],
      providerSince: now.toISOString(),
      cooldownUntil: null,
      lastReason: null,
    },
    event: { type: 'listed', providers: [provider] },
  };
}

function advanceListed(
  step: Step,
  screening: ScreeningResult | null,
  quality: QualityVerdict
): { state: FreeZoneModelState; events: FreeZoneEvent[] } {
  const { state } = step;
  if (quality.kind === 'fail') {
    const next = delistForQuality(state, quality.reasons);
    return { state: next.state, events: [next.event] };
  }
  if (!screening) return { state, events: [] };
  const current = state.providers[0];
  const stillQualified =
    screening.pass && screening.qualified.some((item) => item.provider === current);
  if (stillQualified) return { state, events: [] };
  const reasons = screening.pass ? [`${current} 不再达标`] : screening.reasons;
  const next = switchOrDelist(step, screening, reasons);
  return { state: next.state, events: [next.event] };
}

/**
 * 运营手动上架：不管现在是未上架、冷却中还是停用，直接用 provider 上架。之后和普通在架模型一样：
 * 质量指标从现在重新累计，报价不达标、质量越线照常换供应商或下架。
 */
export function listManually(input: {
  state: FreeZoneModelState;
  provider: string;
  now: Date;
}): Transition {
  const { state, provider, now } = input;
  return {
    state: {
      ...state,
      status: 'listed',
      providers: [provider],
      providerSince: now.toISOString(),
      cooldownUntil: null,
      lastReason: null,
    },
    event: { type: 'listed', providers: [provider], manual: true },
  };
}

/** 真实请求派不出去而当场下架（见 unroutable-guard.ts）：价格原因，冷却后照常评估。 */
export function delistUnroutable(input: {
  state: FreeZoneModelState;
  now: Date;
  relist: FreeZoneRelist;
  reasons: string[];
}): Transition {
  return delistForPrice(input.state, input.now, input.relist, input.reasons);
}

/** 运营手动下架：立即下架并一直停着，不参与自动上架；「立即上架」会把它拿回来。 */
export function delistManually(input: { state: FreeZoneModelState }): Transition {
  return {
    state: cooling(input.state, MANUAL_HOLD_UNTIL, `${MANUAL_DELIST_REASON}：${HOLD_HINT}`),
    event: {
      type: 'delisted',
      cause: null,
      reasons: [MANUAL_DELIST_REASON],
      cooldownUntil: MANUAL_HOLD_UNTIL,
    },
  };
}

/**
 * 推进一个候选模型的状态。screening 为 null 表示这一轮官方数据缺失；
 * quality 只对在架模型有意义（只统计这次上架之后的轮次）。
 */
export function advanceState(input: {
  state: FreeZoneModelState;
  now: Date;
  screening: ScreeningResult | null;
  quality: QualityVerdict;
  relist: FreeZoneRelist;
  priceBandRatio: number;
}): { state: FreeZoneModelState; events: FreeZoneEvent[] } {
  const { now, screening, quality, relist } = input;
  let state = input.state;
  const events: FreeZoneEvent[] = [];
  const step = (s: FreeZoneModelState): Step => ({
    state: s,
    now,
    relist,
    ratio: input.priceBandRatio,
  });

  if (state.status === 'cooling') {
    if (stillCooling(state, now)) return { state, events };
    state = { ...state, status: 'unlisted', cooldownUntil: null };
    events.push({ type: 'cooldown_ended' });
  }

  if (state.status === 'unlisted') {
    const next = screenUnlisted(step(state), screening);
    if (next.event) events.push(next.event);
    return { state: next.state, events };
  }

  const next = advanceListed(step(state), screening, quality);
  return { state: next.state, events: [...events, ...next.events] };
}
