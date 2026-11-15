/**
 * 线上读路径用的栏目快照：运营配置 + 在架模型，进程内缓存 30 秒。
 *
 * 目录接口和每一轮生成都会读，所以不能每次查库。读状态表失败时沿用上一次快照；
 * 进程刚起、一次都没读成功时返回 null，调用方按「栏目不显示、免费模型不可用」处理。
 */
import {
  isFreeZoneModelId,
  type FixedDeductionConfig,
  type FreeZoneCandidate,
  type FreeZoneConfig,
  type PublicFreeZone,
} from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import { fetchFreeZoneConfig } from './config.js';
import { loadFreeZoneStates } from './repository.js';
import { resolveFreeZoneView, type ListedFreeModel } from './zone-view.js';

const log = createLogger('free-zone');
const TTL_MS = 30_000;

export interface FreeZoneSnapshot {
  config: FreeZoneConfig;
  /** 在架模型，按运营配置里的顺序 */
  listed: ListedFreeModel[];
}

let cached: { snapshot: FreeZoneSnapshot; at: number } | null = null;
let inflight: Promise<FreeZoneSnapshot | null> | null = null;

async function load(): Promise<FreeZoneSnapshot | null> {
  const config = await fetchFreeZoneConfig();
  if (config.candidates.length === 0) return { config, listed: [] };
  try {
    const states = await loadFreeZoneStates();
    const listed = config.candidates.flatMap<ListedFreeModel>((candidate) => {
      const state = states.get(candidate.id);
      return state?.status === 'listed' && state.providers.length > 0
        ? [{ candidate, providers: state.providers }]
        : [];
    });
    return { config, listed };
  } catch (err) {
    log.sys.error({ err, event: 'free_zone.snapshot_failed' }, '畅聊状态读取失败，沿用上次快照');
    return cached?.snapshot ?? null;
  }
}

export async function getFreeZoneSnapshot(): Promise<FreeZoneSnapshot | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.snapshot;
  inflight ??= load()
    .then((snapshot) => {
      if (snapshot) cached = { snapshot, at: Date.now() };
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateFreeZoneSnapshot(): void {
  cached = null;
}

export function findListedFreeModel(
  snapshot: FreeZoneSnapshot | null,
  modelId: string | null | undefined
): ListedFreeModel | null {
  if (!snapshot || !isFreeZoneModelId(modelId)) return null;
  return snapshot.listed.find(({ candidate }) => candidate.id === modelId) ?? null;
}

export function findCandidate(
  snapshot: FreeZoneSnapshot | null,
  modelId: string | null | undefined
): FreeZoneCandidate | null {
  if (!snapshot || !isFreeZoneModelId(modelId)) return null;
  return snapshot.config.candidates.find((candidate) => candidate.id === modelId) ?? null;
}

/** 栏目对这个用户、这张卡、此刻的状态；null 表示不显示。 */
export function viewFreeZone(
  snapshot: FreeZoneSnapshot | null,
  input: { now: Date; isOwnCard: boolean; pricing: FixedDeductionConfig }
): PublicFreeZone | null {
  if (!snapshot) return null;
  return resolveFreeZoneView({ config: snapshot.config, listed: snapshot.listed, ...input });
}
