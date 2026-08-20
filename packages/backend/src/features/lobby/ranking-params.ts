/**
 * backend / features / lobby / ranking-params.ts
 *
 * v3 排序分参数的读取口：miniapp.runtime_config.lobby_ranking_params → 校验 → 兜底。
 *
 * 只有刷新 job 会调它，一天一次，所以这里不做缓存——加缓存反而会让「运营改完，
 * 手动触发一次刷新验证」拿到旧值。读一次配置的成本相对于两条全表聚合可以忽略。
 *
 * 兜底一律回到 DEFAULT_LOBBY_RANKING_PARAMS，且必然打日志：运营把配置改坏时，
 * 静默用兜底值算出来的分和用运营值算出来的分都是「一串合理的数字」，
 * 没有日志就没有任何人会发现这一轮用的不是运营设的口径。
 */

import {
  DEFAULT_LOBBY_RANKING_PARAMS,
  LobbyRankingParamsSchema,
  type LobbyRankingParams,
} from '@miniapp/shared';
import type { FastifyBaseLogger } from 'fastify';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';

export const LOBBY_RANKING_PARAMS_CONFIG_KEY = 'lobby_ranking_params';

export interface ResolvedLobbyRankingParams {
  params: LobbyRankingParams;
  /** 运营配置不可用、走了内置兜底 */
  degraded: boolean;
  /** 兜底时为 null；用于日志和落表，方便回溯某一轮分数是哪版参数算的 */
  version: number | null;
}

export async function resolveLobbyRankingParams(
  log: FastifyBaseLogger
): Promise<ResolvedLobbyRankingParams> {
  const fallback: ResolvedLobbyRankingParams = {
    params: DEFAULT_LOBBY_RANKING_PARAMS,
    degraded: true,
    version: null,
  };

  const entry = await fetchRuntimeConfigEntry(LOBBY_RANKING_PARAMS_CONFIG_KEY);
  if (!entry) {
    log.error(
      { kind: 'sys', event: 'lobby_ranking.params_missing' },
      'runtime_config.lobby_ranking_params 缺失，本轮用内置兜底参数'
    );
    return fallback;
  }

  const parsed = LobbyRankingParamsSchema.safeParse(entry.value);
  if (!parsed.success) {
    log.error(
      {
        kind: 'sys',
        event: 'lobby_ranking.params_invalid',
        configVersion: entry.version,
        issues: parsed.error.issues,
      },
      'runtime_config.lobby_ranking_params 不合契约，本轮用内置兜底参数'
    );
    return fallback;
  }

  return { params: parsed.data, degraded: false, version: entry.version };
}
