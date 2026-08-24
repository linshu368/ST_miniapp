/**
 * backend / features / lobby / pinned-characters.ts
 *
 * 首页「推荐」运营固定位的读取口：
 * miniapp.runtime_config.lobby_pinned_characters → 校验 → 兜底。
 *
 * 与 ranking-params 的关键差别是调用频率：那个一天读一次（刷新 job），这个在大厅
 * 读路径上，每次打开首页都要用。所以这里带一层 60 秒内存缓存，TTL 与
 * ranking-stats 的分数缓存对齐——两者本来就要一起用，缓存周期不一致会出现
 * 「新固定位配上了、分数还是上一版」的错位窗口。
 *
 * 兜底一律回到「没有固定位」，即退回纯 v3 排序，并且必然打日志。配置读坏时静默不固定，
 * 和运营配好的固定位在首页上都是「一串合理的卡」，没有日志就没人会发现主推位没生效。
 * 缓存同时兜住日志量：配置坏掉时最多每 60 秒记一条，不会被每个请求刷爆。
 */

import {
  DEFAULT_LOBBY_PINNED_CHARACTERS,
  LOBBY_PINNED_CHARACTERS_CONFIG_KEY,
  LobbyPinnedCharactersSchema,
} from '@miniapp/shared';
import type { FastifyBaseLogger } from 'fastify';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';

const CACHE_TTL_MS = 60_000;

export interface ResolvedLobbyPinnedCharacters {
  /** 按展示顺序排列的固定位 id；空数组表示不固定 */
  characterIds: readonly string[];
  /** 运营配置不可用、走了「不固定」兜底 */
  degraded: boolean;
  /** 兜底时为 null */
  version: number | null;
}

interface CacheEntry {
  resolved: ResolvedLobbyPinnedCharacters;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** 单测与刷新后清缓存用 */
export function clearLobbyPinnedCharactersCache(): void {
  cache = null;
}

export async function resolveLobbyPinnedCharacters(
  log: FastifyBaseLogger
): Promise<ResolvedLobbyPinnedCharacters> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.resolved;

  const resolved = await readPinnedCharacters(log);
  cache = { resolved, expiresAt: now + CACHE_TTL_MS };
  return resolved;
}

async function readPinnedCharacters(
  log: FastifyBaseLogger
): Promise<ResolvedLobbyPinnedCharacters> {
  const fallback: ResolvedLobbyPinnedCharacters = {
    characterIds: DEFAULT_LOBBY_PINNED_CHARACTERS.character_ids,
    degraded: true,
    version: null,
  };

  const entry = await fetchRuntimeConfigEntry(LOBBY_PINNED_CHARACTERS_CONFIG_KEY);
  if (!entry) {
    log.error(
      { kind: 'sys', event: 'lobby_pinned.config_missing' },
      'runtime_config.lobby_pinned_characters 缺失，本次不固定前几位'
    );
    return fallback;
  }

  const parsed = LobbyPinnedCharactersSchema.safeParse(entry.value);
  if (!parsed.success) {
    log.error(
      {
        kind: 'sys',
        event: 'lobby_pinned.config_invalid',
        configVersion: entry.version,
        issues: parsed.error.issues,
      },
      'runtime_config.lobby_pinned_characters 不合契约，本次不固定前几位'
    );
    return fallback;
  }

  return {
    characterIds: parsed.data.character_ids,
    degraded: false,
    version: entry.version,
  };
}
