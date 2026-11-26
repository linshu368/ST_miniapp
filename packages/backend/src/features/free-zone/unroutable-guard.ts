/**
 * 真实请求连续被 Surplus 拒单就自动下架：报价跌破折扣底线（404 minimum_discount_not_met）或没有卖家（503）时，
 * 每一轮都由兜底交付，用户选的模型等于没用上。
 *
 * Surplus 短时补货间隙（卖家被临时摘掉、限流）也会返回同样的错误，所以除了次数还要求持续一段时间；
 * 中间有一次派出去就重新计。响应头前就停下的（并发落败、兜底抢先）和其它错误不算，也不打断。
 * 计数在进程内，多副本各算各的，重启清零：只会晚一点下架，不会误下架。
 * 只有下架这一步落库（锁行、确认还在架、供应商没换过、没被保上）。恢复由运营手动点「上架」。
 * 保上的模型照常计数、到了门槛只记日志（skip_reason=pinned），不下架。
 */
import { createLogger } from '../../lib/logger.js';
import { delistUnroutable } from './lifecycle.js';
import { saveDelisting } from './repository.js';
import { invalidateFreeZoneSnapshot } from './snapshot.js';

/** 连续拒单至少这么多次 */
export const REFUSAL_MIN_STREAK = 10;
/** 第一次到最近一次拒单至少隔这么久 */
export const REFUSAL_MIN_SPAN_MS = 10 * 60 * 1000;

/** Surplus 明确拒绝派单：折扣底线达不到 / 没有可用卖家 */
export function isUnroutableStatus(status: number): boolean {
  return status === 404 || status === 503;
}

export interface PrimaryCallOutcome {
  candidateId: string;
  /** 这一轮用的供应商；换了供应商就重新计数 */
  providers: string[];
  httpStatus: number | null;
}

interface GuardLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** delisted 已下架；pinned 运营保上、不下架；unchanged 已不在架或供应商已经换了 */
export type UnroutableDelistOutcome = 'delisted' | 'pinned' | 'unchanged';

export interface UnroutableGuardDeps {
  /** 落库下架 */
  delist(input: {
    candidateId: string;
    providers: string[];
    reasons: string[];
  }): Promise<UnroutableDelistOutcome>;
  now(): number;
  log: GuardLog;
}

interface Streak {
  providersKey: string;
  refused: number;
  since: number;
  delisting: boolean;
}

export function createUnroutableGuard(deps: UnroutableGuardDeps) {
  const streaks = new Map<string, Streak>();
  return function note(call: PrimaryCallOutcome): void {
    if (call.httpStatus === null) return;
    if (call.httpStatus < 400) {
      streaks.delete(call.candidateId);
      return;
    }
    if (!isUnroutableStatus(call.httpStatus)) return;
    const now = deps.now();
    const providersKey = call.providers.join(',');
    let streak = streaks.get(call.candidateId);
    if (!streak || streak.providersKey !== providersKey) {
      streak = { providersKey, refused: 0, since: now, delisting: false };
      streaks.set(call.candidateId, streak);
    }
    if (streak.delisting) return;
    streak.refused += 1;
    if (streak.refused < REFUSAL_MIN_STREAK || now - streak.since < REFUSAL_MIN_SPAN_MS) return;

    streak.delisting = true;
    const minutes = Math.floor((now - streak.since) / 60_000);
    const reasons = [`连续 ${streak.refused} 次被拒单（${minutes} 分钟，报价跌破底线或没有卖家）`];
    const context = { candidateId: call.candidateId, providers: call.providers, reasons };
    const current = streak;
    void deps
      .delist(context)
      .then((outcome) =>
        outcome === 'delisted'
          ? deps.log.info(
              { event: 'free_zone.delisted', ...context },
              '真实请求连续被拒单，已自动下架'
            )
          : deps.log.info(
              {
                event: 'free_zone.unroutable_skipped',
                ...context,
                skip_reason: outcome === 'pinned' ? 'pinned' : 'not_listed_or_switched',
              },
              outcome === 'pinned'
                ? '真实请求连续被拒单，模型已保上，不下架'
                : '真实请求连续被拒单，但模型已不在架或已换供应商'
            )
      )
      .catch((err: unknown) =>
        deps.log.warn(
          { event: 'free_zone.unroutable_delist_failed', err, ...context },
          '连续拒单下架写入失败，重新计数'
        )
      )
      .finally(() => {
        // 下架成功、没动或失败都从头计数：失败时再攒够会重试
        if (streaks.get(call.candidateId) === current) streaks.delete(call.candidateId);
      });
  };
}

async function delistInDb(input: {
  candidateId: string;
  providers: string[];
  reasons: string[];
}): Promise<UnroutableDelistOutcome> {
  let pinned = false;
  const outcome = await saveDelisting({
    candidateId: input.candidateId,
    build: (current) => {
      if (current.providers.join(',') !== input.providers.join(',')) return null;
      // 在锁住的这一行上判断，刚点了保上的不会被并发的拒单下掉
      pinned = current.pinned;
      return delistUnroutable({ state: current, reasons: input.reasons });
    },
  });
  if (outcome.kind !== 'saved') return pinned ? 'pinned' : 'unchanged';
  invalidateFreeZoneSnapshot();
  return 'delisted';
}

const log = createLogger('free-zone');

/** 每一路免费模型主请求结束时调用（生成链路），不等待、不抛错 */
export const noteFreeZonePrimaryCall = createUnroutableGuard({
  delist: delistInDb,
  now: Date.now,
  log: { info: (obj, msg) => log.biz.info(obj, msg), warn: (obj, msg) => log.sys.warn(obj, msg) },
});
