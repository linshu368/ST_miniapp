/**
 * 用户当前选择的免费模型，此刻在这张角色卡上能不能用；不能用就换成谁。
 *
 * 选择按用户存（不按角色卡）。不可用的原因：模型被下架、栏目对这张卡/此刻不开放、
 * 这个用户 24 小时内用满了这个模型的上限（usage-limit.ts）。
 * 换的顺序：同系列没用满的在架模型 → 随机一个没用满的在架模型 → 付费目录的默认模型（目前是 1017）。
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
import { needsAccessFacts } from './access.js';
import type { AccessFactsLoader } from './access-facts.js';
import { chooseReplacement, type ListedFreeModel } from './zone-view.js';
import { NO_EXHAUSTED, type ExhaustedFreeModels, type FreeZoneUsageLoader } from './usage-limit.js';

const ZERO_PRICING: FixedDeductionConfig = {
  freeQuotaExhausted: 0,
  light: 0,
  standard: 0,
  premium: 0,
};

/**
 * 自动换模型的记录。下架、关闭只写日志（用户自己在公告里说明，关闭另有分隔线）；
 * 用满上限的在生成链路里轻提示一句（FreeZoneLimitSwitch）。
 */
export interface SelectionReplacement {
  fromName: string;
  toName: string;
  reason: 'delisted' | 'closed' | 'limit_reached';
  /** 换成了付费目录的模型（没有能用的免费模型） */
  toPaid: boolean;
  /** limit_reached：原模型什么时候恢复 */
  resetsAt: string | null;
}

export type FreeZoneSelection =
  | { kind: 'usable'; listed: ListedFreeModel; snapshot: FreeZoneSnapshot }
  | { kind: 'replaced'; toModelId: string; replacement: SelectionReplacement };

/** 只有栏目开放才算可用；其余状态（未开始/仅限自创/没有模型/会员等下次/会员专享）都不可用。 */
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
 * 对这个用户关闭（试用到期、畅聊日结束…）时不拦截：换成付费默认模型照常生成。
 */
export async function resolveFreeZoneSelection(input: {
  persistedModelId: string | null;
  userId: string;
  characterId: string | null;
  catalog: ModelCatalog;
  /** 按身份开放要用的用户事实；只在需要时调用 */
  loadFacts: AccessFactsLoader;
  /** 每人 24 小时上限；不传按不限 */
  loadUsage?: FreeZoneUsageLoader;
  /**
   * 选中的模型用满时要不要换掉（默认要）。目录接口传 false：只在栏目里标「已用完」，
   * 等真正发消息时再换，换的那一轮才有提示。
   */
  enforceLimit?: boolean;
  isOwnCard?: boolean;
  now?: Date;
}): Promise<FreeZoneSelection | null> {
  if (!isFreeZoneModelId(input.persistedModelId)) return null;
  const now = input.now ?? new Date();
  const snapshot = await getFreeZoneSnapshot();
  const needsOwnership = snapshot?.config.scope === 'own_cards';
  const [isOwnCard, facts] = await Promise.all([
    input.isOwnCard ??
      (needsOwnership ? isOwnCharacter(input.userId, input.characterId) : Promise.resolve(false)),
    snapshot && needsAccessFacts(snapshot.config, now) ? input.loadFacts() : Promise.resolve(null),
  ]);
  const view = viewFreeZone(snapshot, { now, isOwnCard, pricing: ZERO_PRICING, facts });
  const listed = findListedFreeModel(snapshot, input.persistedModelId);
  const open = snapshot !== null && isUsable(view);
  const exhausted: ExhaustedFreeModels =
    open && input.loadUsage ? await input.loadUsage(snapshot) : NO_EXHAUSTED;
  const resetsAt = listed ? (exhausted.get(listed.candidate.id) ?? null) : null;
  if (listed && open && (resetsAt === null || input.enforceLimit === false)) {
    return { kind: 'usable', listed, snapshot };
  }

  const current = findCandidate(snapshot, input.persistedModelId);
  const usable = open
    ? snapshot.listed.filter(({ candidate }) => !exhausted.has(candidate.id))
    : [];
  const replacement = chooseReplacement({ currentFamily: current?.family ?? null, usable });
  const fallback = input.catalog.tiers
    .flatMap((tier) => tier.models)
    .find((model) => model.id === input.catalog.default_model_id);
  const reason = !listed ? 'delisted' : open ? 'limit_reached' : 'closed';
  return {
    kind: 'replaced',
    toModelId: replacement?.id ?? input.catalog.default_model_id,
    replacement: {
      fromName: current?.display_name ?? '畅聊模型',
      toName: replacement?.display_name ?? fallback?.display_name ?? '默认模型',
      reason,
      toPaid: replacement === null,
      resetsAt: reason === 'limit_reached' ? resetsAt : null,
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
  loadFacts: AccessFactsLoader;
  loadUsage: FreeZoneUsageLoader;
  now?: Date;
}): Promise<{
  view: PublicFreeZone | null;
  usable: ListedFreeModel | null;
  modelId: string | null;
  replacement: SelectionReplacement | null;
}> {
  const now = input.now ?? new Date();
  const snapshot = await getFreeZoneSnapshot();
  const [facts, settled] = await Promise.all([
    snapshot && needsAccessFacts(snapshot.config, now) ? input.loadFacts() : null,
    settleFreeZoneSelection({
      persistedModelId: input.settingsModelId,
      userId: input.userId,
      characterId: input.characterId,
      catalog: input.catalog,
      isOwnCard: input.isOwnCard,
      loadFacts: input.loadFacts,
      loadUsage: input.loadUsage,
      enforceLimit: false,
      now,
    }),
  ]);
  const view = viewFreeZone(snapshot, {
    now,
    isOwnCard: input.isOwnCard,
    pricing: input.pricing,
    facts,
  });
  // 选着付费模型的用户打开面板，也要看到哪些免费模型已用完
  const exhausted = snapshot && isUsable(view) ? await input.loadUsage(snapshot) : NO_EXHAUSTED;
  return {
    view: markExhausted(view, exhausted),
    usable: settled.usable?.listed ?? null,
    modelId: settled.modelId,
    replacement: settled.replacement,
  };
}

/** 给栏目里用满了的模型标上恢复时间 */
function markExhausted(
  view: PublicFreeZone | null,
  exhausted: ExhaustedFreeModels
): PublicFreeZone | null {
  if (!view || exhausted.size === 0) return view;
  return {
    ...view,
    models: view.models.map((model) => ({
      ...model,
      limit_resets_at: exhausted.get(model.id) ?? null,
    })),
  };
}
