/**
 * 畅聊每人 24 小时上限：在架的免费模型里，这个用户哪些已经用满、什么时候恢复。
 *
 * 上限按模型：模型自己设了用它，没设用畅聊配置的全局上限，都没设不限（不查库）。
 * 只数成功的轮次（含重新生成），滚动 24 小时。查库失败或太慢按「都没用满」处理：
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
const log = createLogger('free-zone');

/** 在架模型各自的上限；不限的不列 */
export function listedTurnLimits(
  snapshot: FreeZoneSnapshot
): Array<{ modelId: string; limit: number }> {
  return snapshot.listed.flatMap(({ candidate }) => {
    const limit = freeZoneTurnLimit(snapshot.config, candidate);
    return limit === null ? [] : [{ modelId: candidate.id, limit }];
  });
}

async function loadExhausted(userId: string, snapshot: FreeZoneSnapshot) {
  const limits = listedTurnLimits(snapshot);
  if (limits.length === 0) return NO_EXHAUSTED;
  let timer: NodeJS.Timeout | undefined;
  try {
    const usage = await Promise.race([
      loadFreeZoneTurnUsage(userId, limits),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('free zone usage query timed out')),
          QUERY_TIMEOUT_MS
        );
      }),
    ]);
    const exhausted = new Map<string, string>();
    for (const { modelId, limit } of limits) {
      const used = usage.get(modelId);
      if (used && used.turns >= limit && used.resetsAt) exhausted.set(modelId, used.resetsAt);
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

export function createFreeZoneUsageLoader(userId: string): FreeZoneUsageLoader {
  let pending: Promise<ExhaustedFreeModels> | null = null;
  return (snapshot) => (pending ??= loadExhausted(userId, snapshot));
}
