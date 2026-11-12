/**
 * 把派单探测接进官方初筛：只探「这一轮会用的那家」——在架的就是在用的那家，
 * 准备上架的就是 pickProvider 会挑的那家。派不出去（或首字超过探测上限）就从达标名单里去掉，
 * 按同一套规则探下一家，最多 MAX_PROBES 家；探测说不清（网络等）就整轮维持现状。
 */
import type { FreeZoneProbe, FreeZoneScreening } from '@miniapp/shared';
import type { FreeZoneModelState } from './lifecycle.js';
import type { ProbeFn } from './probe.js';
import { pickProvider, type ScreeningResult } from './screening.js';

const MAX_PROBES = 3;

export interface ProbedScreening {
  /** 去掉探测失败的供应商后的初筛结果（没探测时原样） */
  screening: ScreeningResult | null;
  /** true：探测说不清，本轮不推进状态 */
  hold: boolean;
  probes: FreeZoneProbe[];
  /** 最终选定那家的探测；没选出来时为最后一次探测 */
  chosen: FreeZoneProbe | null;
}

function failure(probe: FreeZoneProbe, maxTtftMs: number | null): string | null {
  if (probe.outcome === 'unroutable')
    return `${probe.provider}: 探测派不出去（${probe.detail ?? ''}）`;
  if (probe.outcome === 'ok' && maxTtftMs !== null && (probe.first_token_ms ?? 0) > maxTtftMs) {
    return `${probe.provider}: 探测首字 ${probe.first_token_ms} > ${maxTtftMs}`;
  }
  return null;
}

function activeExclusions(state: FreeZoneModelState, now: Date): Set<string> {
  return new Set(
    Object.entries(state.excludedProviders)
      .filter(([, until]) => Date.parse(until) > now.getTime())
      .map(([provider]) => provider)
  );
}

/** 探测这一项的汇总：探了几家、几家派得出去且首字不超上限 */
export function probeCheck(
  probes: FreeZoneProbe[],
  rules: FreeZoneScreening
): { threshold: number; passed: number; total: number } | null {
  if (probes.length === 0) return null;
  return {
    threshold: rules.min_discount_pct,
    passed: probes.filter(
      (probe) => probe.outcome === 'ok' && !failure(probe, rules.max_probe_ttft_ms)
    ).length,
    total: probes.length,
  };
}

export async function applyProbes(input: {
  model: string;
  screening: ScreeningResult | null;
  state: FreeZoneModelState;
  now: Date;
  rules: FreeZoneScreening;
  probe: ProbeFn;
}): Promise<ProbedScreening> {
  const { screening, state, now, rules } = input;
  const untouched = { screening, hold: false, probes: [], chosen: null };
  const cooling =
    state.status === 'cooling' &&
    state.cooldownUntil !== null &&
    Date.parse(state.cooldownUntil) > now.getTime();
  if (!screening?.pass || !rules.probe_enabled || cooling) return untouched;

  const current = state.status === 'listed' ? (state.providers[0] ?? null) : null;
  const excluded = activeExclusions(state, now);
  let qualified = [...screening.qualified];
  const probes: FreeZoneProbe[] = [];
  const reasons: string[] = [];
  for (let attempt = 0; attempt < MAX_PROBES; attempt += 1) {
    const provider = pickProvider(qualified, {
      current,
      excluded,
      ratio: rules.price_band_ratio,
    });
    if (!provider) break;
    const result = await input.probe({
      model: input.model,
      provider,
      minDiscountPct: rules.min_discount_pct,
    });
    probes.push(result);
    if (result.outcome === 'error') return { screening, hold: true, probes, chosen: result };
    const failed = failure(result, rules.max_probe_ttft_ms);
    if (!failed) {
      return {
        screening: { ...screening, qualified, reasons: [...screening.reasons, ...reasons] },
        hold: false,
        probes,
        chosen: result,
      };
    }
    reasons.push(failed);
    qualified = qualified.filter((item) => item.provider !== provider);
  }
  // 一家都没探（达标的都在排除期）：交给状态机按原样处理
  if (probes.length === 0) return untouched;
  // 探到上限还没有能派单的：剩下没探的也不放行，宁可这一轮不上
  return {
    screening: {
      ...screening,
      qualified: [],
      pass: false,
      reasons: [...screening.reasons, ...reasons],
    },
    hold: false,
    probes,
    chosen: probes.at(-1) ?? null,
  };
}
