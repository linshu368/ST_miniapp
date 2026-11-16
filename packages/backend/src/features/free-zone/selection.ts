/**
 * 用户当前选择的免费模型，此刻在这张角色卡上能不能用；不能用就换成谁。
 *
 * 选择按用户存（不按角色卡）。不可用的原因：模型被下架、栏目对这张卡/此刻不开放。
 * 换的顺序：同系列在架模型 → 随机一个在架模型 → 付费目录的默认模型（目前是 1017）。
 * 只做判断不写库，写回由调用方做（目录接口和生成链路的写法不同）。
 */
import {
  isFreeZoneModelId,
  type FixedDeductionConfig,
  type ModelCatalog,
  type PublicFreeZone,
} from '@miniapp/shared';
import { getCharacterCreatorOwner } from '../generation/creator-billing.js';
import {
  findCandidate,
  findListedFreeModel,
  getFreeZoneSnapshot,
  viewFreeZone,
  type FreeZoneSnapshot,
} from './snapshot.js';
import { chooseReplacement, type ListedFreeModel } from './zone-view.js';

const ZERO_PRICING: FixedDeductionConfig = {
  freeQuotaExhausted: 0,
  light: 0,
  standard: 0,
  premium: 0,
};

/** 自动换模型的记录（只写日志，不给用户弹提示：用户自己在公告里说明）。 */
export interface SelectionReplacement {
  fromName: string;
  toName: string;
  reason: 'delisted' | 'closed';
}

export type FreeZoneSelection =
  | { kind: 'usable'; listed: ListedFreeModel; snapshot: FreeZoneSnapshot }
  | { kind: 'replaced'; toModelId: string; replacement: SelectionReplacement };

/** 只有栏目开放才算可用；未开放的三种状态（未开始/仅限自创/没有模型）都不可用。 */
export function isUsable(view: PublicFreeZone | null): boolean {
  return view?.state === 'open';
}

export async function isOwnCharacter(userId: string, characterId: string | null): Promise<boolean> {
  if (!characterId) return false;
  return (await getCharacterCreatorOwner(characterId)) === userId;
}

/**
 * 已选的是免费模型时返回判断结果；不是免费模型返回 null，调用方走原来的付费目录逻辑。
 * isOwnCard 由调用方提供（目录接口本来就查过），生成链路传 undefined 时这里按需查。
 */
export async function resolveFreeZoneSelection(input: {
  persistedModelId: string | null;
  userId: string;
  characterId: string | null;
  catalog: ModelCatalog;
  isOwnCard?: boolean;
  now?: Date;
}): Promise<FreeZoneSelection | null> {
  if (!isFreeZoneModelId(input.persistedModelId)) return null;
  const snapshot = await getFreeZoneSnapshot();
  const needsOwnership = snapshot?.config.scope === 'own_cards';
  const isOwnCard =
    input.isOwnCard ??
    (needsOwnership ? await isOwnCharacter(input.userId, input.characterId) : false);
  const view = viewFreeZone(snapshot, {
    now: input.now ?? new Date(),
    isOwnCard,
    pricing: ZERO_PRICING,
  });
  const listed = findListedFreeModel(snapshot, input.persistedModelId);
  if (listed && snapshot && isUsable(view)) return { kind: 'usable', listed, snapshot };

  const current = findCandidate(snapshot, input.persistedModelId);
  const replacement =
    snapshot && isUsable(view)
      ? chooseReplacement({ currentFamily: current?.family ?? null, usable: snapshot.listed })
      : null;
  const fallback = input.catalog.tiers
    .flatMap((tier) => tier.models)
    .find((model) => model.id === input.catalog.default_model_id);
  return {
    kind: 'replaced',
    toModelId: replacement?.id ?? input.catalog.default_model_id,
    replacement: {
      fromName: current?.display_name ?? '畅聊模型',
      toName: replacement?.display_name ?? fallback?.display_name ?? '默认模型',
      reason: listed ? 'closed' : 'delisted',
    },
  };
}

export interface SettledFreeZoneSelection {
  /** 可用的免费模型；null 表示最终落在付费目录上 */
  usable: Extract<FreeZoneSelection, { kind: 'usable' }> | null;
  /** 应该持久化的选择（可能是换过的） */
  modelId: string | null;
  replacement: SelectionReplacement | null;
}

/**
 * 判断并在需要时换一次：换成的如果还是免费模型，再确认一次可用（同一快照，必然可用）。
 * 写回由调用方做：目录接口用 setSelectedModelId，生成链路用 correctSelectedModelId。
 */
export async function settleFreeZoneSelection(
  input: Parameters<typeof resolveFreeZoneSelection>[0]
): Promise<SettledFreeZoneSelection> {
  const first = await resolveFreeZoneSelection(input);
  if (!first) return { usable: null, modelId: input.persistedModelId, replacement: null };
  if (first.kind === 'usable')
    return { usable: first, modelId: input.persistedModelId, replacement: null };
  const second = await resolveFreeZoneSelection({ ...input, persistedModelId: first.toModelId });
  return {
    usable: second?.kind === 'usable' ? second : null,
    modelId: first.toModelId,
    replacement: first.replacement,
  };
}

/** 目录接口用：栏目对外状态 + 选择是否可用/被替换。 */
export async function resolveCatalogFreeZone(input: {
  userId: string;
  characterId: string | null;
  settingsModelId: string | null;
  catalog: ModelCatalog;
  isOwnCard: boolean;
  pricing: FixedDeductionConfig;
  now?: Date;
}): Promise<{
  view: PublicFreeZone | null;
  usable: ListedFreeModel | null;
  modelId: string | null;
  replacement: SelectionReplacement | null;
}> {
  const now = input.now ?? new Date();
  const [snapshot, settled] = await Promise.all([
    getFreeZoneSnapshot(),
    settleFreeZoneSelection({
      persistedModelId: input.settingsModelId,
      userId: input.userId,
      characterId: input.characterId,
      catalog: input.catalog,
      isOwnCard: input.isOwnCard,
      now,
    }),
  ]);
  return {
    view: viewFreeZone(snapshot, { now, isOwnCard: input.isOwnCard, pricing: input.pricing }),
    usable: settled.usable?.listed ?? null,
    modelId: settled.modelId,
    replacement: settled.replacement,
  };
}
