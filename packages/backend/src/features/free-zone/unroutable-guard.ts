/**
 * 真实请求「派不出去」就当场下架，不等 30 分钟一轮的评估。
 *
 * 派单探测只发一个几个字的小请求，Surplus 按请求估算折扣，小请求派得出去，几万 token 的
 * 真实对话却可能几乎全被拒（404 minimum_discount_not_met、503 no_healthy_sellers）：
 * 每轮都落到原价兜底，而报错兜底不设上限，模型一直不下架。2026-11-16 DeepSeek V4.1 Flash
 * 上架后 93% 的轮次如此。
 *
 * 这里按每个在架模型最近的真实主请求计数（并发的每一路各算一次，响应头前就停下的不算）：
 * 最近 20 次里至少 10 次，派不出去的比例超过运营设的上限（on_shelf.max_unroutable_pct）
 * 就立即下架。这是价格原因：冷却 relist.price_cooldown_minutes 后照常由评估按报价重新上架。
 * 计数在进程内，多副本各算各的；只有下架这一步落库（锁行、确认还在架、供应商没换过）。
 */
import { createLogger } from '../../lib/logger.js';
import { fetchFreeZoneConfig } from './config.js';
import { delistUnroutable } from './lifecycle.js';
import { saveDelisting } from './repository.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';

/** 看最近多少次主请求 */
export const UNROUTABLE_WINDOW_CALLS = 20;
/** 至少这么多次才判断，几次偶发的拒单不算 */
export const UNROUTABLE_MIN_CALLS = 10;
/** 更早的不算：低流量模型隔几个小时的零星拒单不该凑成一次下架 */
export const UNROUTABLE_MAX_AGE_MS = 60 * 60 * 1000;

/** Surplus 明确拒绝派单：折扣底线达不到 / 没有可用卖家（与派单探测同一口径） */
export function isUnroutableStatus(status: number): boolean {
  return status === 404 || status === 503;
}

export interface RoutingSample {
  at: number;
  unroutable: boolean;
}

export interface UnroutableVerdict {
  calls: number;
  unroutable: number;
  trip: boolean;
}

export function judgeUnroutable(
  samples: readonly RoutingSample[],
  now: number,
  maxPct: number | null
): UnroutableVerdict {
  const recent = samples
    .filter((sample) => now - sample.at <= UNROUTABLE_MAX_AGE_MS)
    .slice(-UNROUTABLE_WINDOW_CALLS);
  const unroutable = recent.filter((sample) => sample.unroutable).length;
  const trip =
    maxPct !== null &&
    recent.length >= UNROUTABLE_MIN_CALLS &&
    (unroutable / recent.length) * 100 > maxPct;
  return { calls: recent.length, unroutable, trip };
}

export interface PrimaryCallOutcome {
  candidateId: string;
  /** 这一轮用的供应商；评估换了供应商就重新计数 */
  providers: string[];
  httpStatus: number | null;
  maxUnroutablePct: number | null;
}

interface GuardLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface UnroutableGuardDeps {
  /** 落库下架；返回 false 表示没动（已不在架、或供应商已经换了） */
  delist(input: { candidateId: string; providers: string[]; reasons: string[] }): Promise<boolean>;
  now(): number;
  log: GuardLog;
}

interface Track {
  providersKey: string;
  samples: RoutingSample[];
  delisting: boolean;
}

export function createUnroutableGuard(deps: UnroutableGuardDeps) {
  const tracks = new Map<string, Track>();
  return function note(call: PrimaryCallOutcome): void {
    if (call.httpStatus === null || call.maxUnroutablePct === null) return;
    const providersKey = call.providers.join(',');
    let track = tracks.get(call.candidateId);
    if (!track || track.providersKey !== providersKey) {
      track = { providersKey, samples: [], delisting: false };
      tracks.set(call.candidateId, track);
    }
    if (track.delisting) return;
    const now = deps.now();
    track.samples = [
      ...track.samples,
      { at: now, unroutable: isUnroutableStatus(call.httpStatus) },
    ].slice(-UNROUTABLE_WINDOW_CALLS);
    const verdict = judgeUnroutable(track.samples, now, call.maxUnroutablePct);
    if (!verdict.trip) return;

    track.delisting = true;
    const reasons = [
      `真实请求派不出去 ${verdict.unroutable}/${verdict.calls} > ${call.maxUnroutablePct}%`,
    ];
    const context = { candidateId: call.candidateId, providers: call.providers, reasons };
    void deps
      .delist(context)
      .then((delisted) =>
        deps.log.info(
          { event: delisted ? 'free_zone.delisted' : 'free_zone.unroutable_skipped', ...context },
          delisted ? '真实请求派不出去，已立即下架' : '真实请求派不出去，但模型已不在架或已换供应商'
        )
      )
      .catch((err: unknown) =>
        deps.log.warn(
          { event: 'free_zone.unroutable_delist_failed', err, ...context },
          '派不出去下架写入失败，重新计数'
        )
      )
      .finally(() => {
        // 下架成功、没动或失败都从头计数：失败时再攒够样本会重试
        if (tracks.get(call.candidateId) === track) tracks.delete(call.candidateId);
      });
  };
}

async function delistInDb(input: {
  candidateId: string;
  providers: string[];
  reasons: string[];
}): Promise<boolean> {
  const config = await fetchFreeZoneConfig();
  const outcome = await saveDelisting({
    candidateId: input.candidateId,
    build: (current) =>
      current.providers.join(',') === input.providers.join(',')
        ? delistUnroutable({
            state: current,
            now: new Date(),
            relist: config.relist,
            reasons: input.reasons,
          })
        : null,
  });
  if (outcome.kind !== 'saved') return false;
  invalidateFreeZoneSnapshot();
  return true;
}

const log = createLogger('free-zone');

/** 每一路免费模型主请求结束时调用（生成链路），不等待、不抛错 */
export const noteFreeZonePrimaryCall = createUnroutableGuard({
  delist: delistInDb,
  now: Date.now,
  log: { info: (obj, msg) => log.biz.info(obj, msg), warn: (obj, msg) => log.sys.warn(obj, msg) },
});
