/**
 * backend / features / generation / resolve-model.ts
 *
 * 权威模型解析（M3a）。搬自 routes/llm-proxy.ts 原第 234~278 行的核心三步：
 *   读持久化的模型选择 → 取模型目录快照 → 解析成实际路由到的上游模型。
 *
 * 模型选择以后端持久化设置为权威来源，请求体里带来的 model 一律被覆盖：ST iframe 的
 * 运行时设置可能因 WebView 事件未生效而停留在旧模型，继续信任它会出现 UI 已切换、
 * 实际生成和计费仍走旧模型。
 *
 * 解析动作独立成函数而不是留在生成出口内部，是因为调用方要先拿到 model 才能做后续决策
 * （ST 链路要回写请求体，自研链路要解析绑定的预设），两处各解析一次会漂移。
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
 * 入参而不是内部读取，是因为 simulation 链路的模型选择存在
 * miniapp_simulation.conversations 而不是用户设置里（决策 8：simulation 不属于本方案范围，
 * 取数分支留在 llm-proxy）。
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
 * 自研链路的模型解析入口：在权威模型之上补齐计费所需的档位与免费属性。
 *
 * ST 链路不走这里——它在 handler 里另有 simulation 分支，且计费上下文是在稍后的计费段
 * 现取的，提前取会平白多一次 runtime_config 读取。
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
