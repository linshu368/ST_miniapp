/**
 * 畅聊每人每天上限：在架的免费模型里，这个用户哪些已经用满、什么时候恢复。
 *
 * 上限按模型：模型自己设了用它，没设用畅聊配置的全局上限，都没设不限（不查库）。
 * 只数成功的轮次（含重新生成），北京时间每天 12 点清零。查库失败或太慢按「都没用满」处理：
 * 宁可多送几轮，也不因为统计挡住用户。
 */
import { freeZoneTurnLimit } from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import { loadFreeZoneTurnUsage } from './repository.js';
import type { FreeZoneSnapshot } from './snapshot.js';

/** 用满了的免费模型 id → 恢复时间（ISO） */
export type ExhaustedFreeModels = ReadonlyMap<string, string>;
/** 同一个请求里多次调用只查一次库 */
export type FreeZoneUsageLoader = (snapshot: FreeZoneSnapshot) => Promise<ExhaustedFreeModels>;

export const NO_EXHAUSTED: ExhaustedFreeModels = new Map();
const QUERY_TIMEOUT_MS = 2_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * 北京时间 12:00（= UTC 04:00，北京无夏令时）清零。不放 0 点：对话高峰在 21:00–02:00，
 * 0 点清零会让晚上猛聊的人到凌晨再拿一整份额度；滚动 24 小时又会让用满的人每过几分钟只恢复 1 轮。
 */
const RESET_AT_UTC_MS = (12 - 8) * HOUR_MS;
const log = createLogger('free-zone');

/** now 所在的额度日：从最近一次北京时间 12 点开始，到下一次 12 点恢复 */
export function freeZoneUsageDay(now: Date): { startsAt: Date; resetsAt: Date } {
  const startsAt =
    Math.floor((now.getTime() - RESET_AT_UTC_MS) / DAY_MS) * DAY_MS + RESET_AT_UTC_MS;
  return { startsAt: new Date(startsAt), resetsAt: new Date(startsAt + DAY_MS) };
}

/** 在架模型各自的上限；不限的不列 */
export function listedTurnLimits(
  snapshot: FreeZoneSnapshot
): Array<{ modelId: string; limit: number }> {
  return snapshot.listed.flatMap(({ candidate }) => {
    const limit = freeZoneTurnLimit(snapshot.config, candidate);
    return limit === null ? [] : [{ modelId: candidate.id, limit }];
  });
}

async function loadExhausted(userId: string, snapshot: FreeZoneSnapshot, now: Date) {
  const limits = listedTurnLimits(snapshot);
  if (limits.length === 0) return NO_EXHAUSTED;
  const day = freeZoneUsageDay(now);
  let timer: NodeJS.Timeout | undefined;
  try {
    const usage = await Promise.race([
      loadFreeZoneTurnUsage(
        userId,
        limits.map((item) => item.modelId),
        day.startsAt
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('free zone usage query timed out')),
          QUERY_TIMEOUT_MS
        );
      }),
    ]);
    const resetsAt = day.resetsAt.toISOString();
    const exhausted = new Map<string, string>();
    for (const { modelId, limit } of limits) {
      if ((usage.get(modelId) ?? 0) >= limit) exhausted.set(modelId, resetsAt);
    }
    return exhausted;
  } catch (err) {
    log.sys.error(
      { err, event: 'free_zone.usage_failed', userId },
      '畅聊用量读取失败，本次按都没用满处理'
    );
    return NO_EXHAUSTED;
  } finally {
    clearTimeout(timer);
  }
}

export function createFreeZoneUsageLoader(userId: string, now?: Date): FreeZoneUsageLoader {
  let pending: Promise<ExhaustedFreeModels> | null = null;
  return (snapshot) => (pending ??= loadExhausted(userId, snapshot, now ?? new Date()));
}
