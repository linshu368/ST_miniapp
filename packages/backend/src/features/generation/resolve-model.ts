/**
 * backend / features / generation / resolve-model.ts
 *
 * 权威模型解析。三步：读持久化的模型选择 → 取模型目录快照 → 解析成实际路由到的上游模型。
 *
 * 模型选择只以后端持久化设置为权威来源，客户端请求体里带来的 model 一律被覆盖：
 * 前端的运行时状态可能停留在旧模型，信任它会出现 UI 已切换、实际生成与计费仍走旧模型。
 *
 * 解析动作独立成函数而不是留在生成出口内部，是因为调用方要先拿到 model 才能组 prompt，
 * 而计费上下文又要按同一个模型取；两处各解析一次必然漂移。
 */

import { resolveEffectiveSelectedModelId, resolveEnabledCatalogModel } from '@miniapp/shared';
import { fetchModelCatalogSnapshot, getModelBillingContext } from '../../platform/model-tiers.js';
import { MiniappUserSettingsRepository } from '../../infrastructure/repositories/MiniappUserSettingsRepository.js';
import type { ResolvedModel } from './types.js';

let userSettingsRepository: MiniappUserSettingsRepository | null = null;

function userSettings(): MiniappUserSettingsRepository {
  return (userSettingsRepository ??= new MiniappUserSettingsRepository());
}

export interface AuthoritativeModel {
  /** 模型目录的 stable id */
  modelId: string;
  /** 实际路由到的上游模型 */
  openRouterModelId: string;
}

/**
 * 把持久化的模型选择解析成本次生成实际使用的上游模型。
 *
 * 取 persistedModelId 作入参而不是内部读用户设置，是为了让本函数保持纯解析、
 * 便于单测直接喂各种历史选择值。
 */
export async function resolveAuthoritativeModel(
  persistedModelId: string | null
): Promise<AuthoritativeModel> {
  const snapshot = await fetchModelCatalogSnapshot();
  const effectiveModelId = resolveEffectiveSelectedModelId(snapshot.catalog, persistedModelId);
  const model = resolveEnabledCatalogModel(snapshot.catalog, effectiveModelId);
  return { modelId: model.id, openRouterModelId: model.openrouter_model_id };
}

/**
 * 对话链路的模型解析入口：在权威模型之上补齐计费所需的档位与免费属性。
 */
export async function resolveModelForUser(userId: string): Promise<ResolvedModel> {
  const persistedModelId = await userSettings().getSelectedModelId(userId);
  const authoritative = await resolveAuthoritativeModel(persistedModelId);
  const billing = await getModelBillingContext(authoritative.openRouterModelId);

  return {
    modelId: billing.modelId ?? authoritative.modelId,
    openRouterModelId: authoritative.openRouterModelId,
    tier: billing.modelTier,
    isFree: billing.isFree,
  };
}
