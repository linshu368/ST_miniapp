/**
 * 畅聊候选模型的定时评估：每 30 分钟一轮，所有候选一起推进状态。
 *
 * 只要配置里有候选就评估，不看总开关：运营可以先关着栏目、在 Grafana 里看哪些模型达标，
 * 再打开。总开关只决定用户能不能看到栏目。
 *
 * 外部依赖都按「拿不到就维持现状」处理：Surplus 某个模型的行情拿不到，这个模型本轮
 * 不动；业务指标查询失败，在架模型本轮不按业务数据下架。
 */
import type { FastifyBaseLogger } from 'fastify';
import type { FreeZoneCandidate } from '@miniapp/shared';
import { observeBackgroundRun } from '../../lib/background-observability.js';
import { fetchFreeZoneConfig } from './config.js';
import {
  advanceState,
  initialState,
  judgeBusinessMetrics,
  type BusinessVerdict,
} from './lifecycle.js';
import {
  loadFreeZoneMetrics,
  loadFreeZoneStates,
  saveFreeZoneEvaluation,
  type EvaluatedCandidate,
  type ModelMetrics,
} from './repository.js';
import { screenModel, type ScreeningResult } from './screening.js';
import { fetchSurplusModelMarket, type SurplusModelMarket } from './surplus-market.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';

const INTERVAL_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
/** 多副本错峰启动时，别人刚评估过就不再推进，避免「连续达标」被多算 */
const MIN_INTERVAL_MINUTES = 25;
const JOB = 'free_zone_evaluation';

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;

export function startFreeZoneEvaluationJob(log: FastifyBaseLogger): void {
  if (timer || startupTimer) return;
  const jlog = log.child({ module: 'free-zone' });
  timer = setInterval(() => void runFreeZoneEvaluation(jlog), INTERVAL_MS);
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runFreeZoneEvaluation(jlog);
  }, STARTUP_DELAY_MS);
}

export function stopFreeZoneEvaluationJob(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}

/** 一次最多同时问几个模型：候选多时一口气全发容易被公开接口限流。 */
const MARKET_CONCURRENCY = 4;

async function fetchMarkets(
  candidates: FreeZoneCandidate[],
  log: FastifyBaseLogger
): Promise<Array<SurplusModelMarket | null>> {
  const results: Array<SurplusModelMarket | null> = [];
  for (let start = 0; start < candidates.length; start += MARKET_CONCURRENCY) {
    const batch = candidates.slice(start, start + MARKET_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((candidate) =>
          fetchSurplusModelMarket(candidate.surplus_model).catch((err: unknown) => {
            log.warn(
              {
                kind: 'sys',
                event: 'free_zone.market_unavailable',
                err,
                model: candidate.surplus_model,
              },
              'Surplus 行情拿不到，这个模型本轮维持现状'
            );
            return null;
          })
        )
      ))
    );
  }
  return results;
}

function snapshotMetrics(
  screening: ScreeningResult | null,
  business: BusinessVerdict,
  metrics: ModelMetrics | undefined
): Record<string, unknown> {
  return {
    screening: screening
      ? {
          pass: screening.pass,
          qualified: screening.qualified.map((item) => ({
            provider: item.provider,
            price: item.price,
            ttft_p50_ms: item.ttftP50Ms,
            offers: item.qualifiedOffers,
          })),
          realized_7d_discount_pct: screening.realized7dDiscountPct,
          reasons: screening.reasons.slice(0, 10),
        }
      : null,
    business: business.kind,
    ...(metrics
      ? {
          turns: metrics.turns,
          no_output_pct: metrics.noOutputPct,
          fallback_delivered_pct: metrics.fallbackDeliveredPct,
          timeout_pct: metrics.timeoutPct,
          ttft_p90_ms: metrics.ttftP90Ms,
          dislike_pct: metrics.dislikePct,
          avg_cost_usd: metrics.avgCostUsd,
          avg_prompt_tokens: metrics.avgPromptTokens,
        }
      : {}),
  };
}

export async function runFreeZoneEvaluation(log: FastifyBaseLogger): Promise<void> {
  const startedAt = performance.now();
  if (running) {
    observeBackgroundRun({ job: JOB, outcome: 'skipped', startedAt });
    return;
  }
  running = true;
  try {
    const config = await fetchFreeZoneConfig();
    if (config.candidates.length === 0) {
      observeBackgroundRun({ job: JOB, outcome: 'skipped', startedAt });
      return;
    }
    const states = await loadFreeZoneStates();
    const listed = config.candidates.flatMap((candidate) => {
      const state = states.get(candidate.id);
      return state?.status === 'listed' ? [{ id: candidate.id, since: state.providerSince }] : [];
    });
    const [markets, metrics] = await Promise.all([
      fetchMarkets(config.candidates, log),
      loadFreeZoneMetrics(listed, config.on_shelf.window_hours).catch((err: unknown) => {
        log.error(
          { kind: 'sys', event: 'free_zone.metrics_failed', err },
          '业务指标读取失败，本轮不按业务数据下架'
        );
        return null;
      }),
    ]);

    const now = new Date();
    const evaluated: EvaluatedCandidate[] = config.candidates.map((candidate, index) => {
      const state = states.get(candidate.id) ?? initialState(candidate.id);
      const market = markets[index] ?? null;
      const screening = market ? screenModel(market, config.screening) : null;
      const modelMetrics = metrics?.get(candidate.id);
      const business: BusinessVerdict =
        state.status === 'listed' && metrics
          ? judgeBusinessMetrics(modelMetrics ?? null, config.on_shelf)
          : { kind: 'insufficient', turns: modelMetrics?.turns ?? 0 };
      const next = advanceState({
        state,
        now,
        screening,
        business,
        relist: config.relist,
        priceBandRatio: config.screening.price_band_ratio,
      });
      return {
        surplusModel: candidate.surplus_model,
        state: next.state,
        events: next.events,
        metrics: snapshotMetrics(screening, business, modelMetrics),
      };
    });

    const outcome = await saveFreeZoneEvaluation(evaluated, MIN_INTERVAL_MINUTES);
    if (outcome === 'saved') invalidateFreeZoneSnapshot();
    for (const item of outcome === 'saved' ? evaluated : []) {
      for (const event of item.events) {
        log.info(
          {
            kind: 'biz',
            event: `free_zone.${event.type}`,
            candidateId: item.state.candidateId,
            detail: event,
          },
          '畅聊模型状态变化'
        );
      }
    }
    log.info(
      {
        kind: 'sys',
        event: 'free_zone.evaluated',
        outcome,
        candidates: evaluated.length,
        listed: evaluated.filter((item) => item.state.status === 'listed').length,
        marketsMissing: markets.filter((market) => market === null).length,
      },
      '畅聊评估完成'
    );
    observeBackgroundRun({
      job: JOB,
      outcome: outcome === 'saved' ? 'success' : 'skipped',
      startedAt,
    });
  } catch (err) {
    log.error({ kind: 'sys', event: 'free_zone.evaluation_failed', err }, '畅聊评估失败');
    observeBackgroundRun({ job: JOB, outcome: 'error', startedAt, error: err });
  } finally {
    running = false;
  }
}
