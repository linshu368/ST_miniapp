/**
 * 线上读路径用的栏目快照：运营配置 + 在架模型，进程内缓存 30 秒。
 * 在架模型 = 候选池里运营上架的 Surplus 模型（按候选池顺序）+ 模型目录「免费畅聊」板块里
 * 启用的模型（按目录里的顺序，排在后面；和候选池 id 撞了的跳过）。
 *
 * 目录接口和每一轮生成都会读，所以不能每次查库。读状态表失败时沿用上一次快照；
 * 进程刚起、一次都没读成功时返回 null，调用方按「栏目不显示、免费模型不可用」处理。
 */
import {
  isFreeZoneModelId,
  type CatalogFreeZoneModel,
  type FixedDeductionConfig,
  type FreeZoneConfig,
  type PublicFreeZone,
} from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import { fetchModelCatalogSnapshot } from '../../platform/model-tiers.js';
import { fetchFreeZoneConfig } from './config.js';
import { loadFreeZoneStates } from './repository.js';
import { evaluateFreeZoneAccess, type FreeZoneAccessFacts } from './access.js';
import { resolveFreeZoneView, type FreeZoneEntry, type ListedFreeModel } from './zone-view.js';

const log = createLogger('free-zone');
const TTL_MS = 30_000;

export interface FreeZoneSnapshot {
  config: FreeZoneConfig;
  /** 在架模型：候选池里上架的在前，模型目录板块里启用的在后 */
  listed: ListedFreeModel[];
  /** 模型目录「免费畅聊」板块的全部模型（含停用的），给失效的选择找同系列替换 */
  catalogModels: CatalogFreeZoneModel[];
}

let cached: { snapshot: FreeZoneSnapshot; at: number } | null = null;
let inflight: Promise<FreeZoneSnapshot | null> | null = null;

async function load(): Promise<FreeZoneSnapshot | null> {
  const [config, { catalog }] = await Promise.all([
    fetchFreeZoneConfig(),
    fetchModelCatalogSnapshot(),
  ]);
  const candidateIds = new Set(config.candidates.map((candidate) => candidate.id));
  const catalogModels = (catalog.free_zone_models ?? []).filter(
    (model) => !candidateIds.has(model.id)
  );
  const fromCatalog = catalogModels.flatMap<ListedFreeModel>((candidate) =>
    candidate.enabled ? [{ source: 'catalog', candidate }] : []
  );
  if (config.candidates.length === 0) return { config, listed: fromCatalog, catalogModels };
  try {
    const states = await loadFreeZoneStates();
    const fromSurplus = config.candidates.flatMap<ListedFreeModel>((candidate) => {
      const state = states.get(candidate.id);
      return state?.status === 'listed' && state.providers.length > 0
        ? [{ source: 'surplus', candidate, providers: state.providers }]
        : [];
    });
    return { config, listed: [...fromSurplus, ...fromCatalog], catalogModels };
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

/** 候选池或模型目录板块里的这个免费模型（不管现在能不能用） */
export function findCandidate(
  snapshot: FreeZoneSnapshot | null,
  modelId: string | null | undefined
): FreeZoneEntry | null {
  if (!snapshot || !isFreeZoneModelId(modelId)) return null;
  return (
    snapshot.config.candidates.find((candidate) => candidate.id === modelId) ??
    snapshot.catalogModels.find((model) => model.id === modelId) ??
    null
  );
}

/**
 * 栏目对这个用户、这张卡、此刻的状态；null 表示不显示。
 * facts 只有福利期外、按身份开放打开时才用到（needsAccessFacts）；null 表示没读或读失败。
 */
export function viewFreeZone(
  snapshot: FreeZoneSnapshot | null,
  input: {
    now: Date;
    isOwnCard: boolean;
    pricing: FixedDeductionConfig;
    facts: FreeZoneAccessFacts | null;
  }
): PublicFreeZone | null {
  if (!snapshot) return null;
  const access = evaluateFreeZoneAccess({
    config: snapshot.config,
    now: input.now,
    facts: input.facts,
  });
  return resolveFreeZoneView({
    config: snapshot.config,
    listed: snapshot.listed,
    isOwnCard: input.isOwnCard,
    pricing: input.pricing,
    access,
  });
}
