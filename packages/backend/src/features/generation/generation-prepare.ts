import { getModelBillingContext } from '../../platform/model-tiers.js';
import { getPricingConfig } from '../../platform/model-tiers.js';
import {
  getProviderPreferencesForModels,
  getProviderRoutingConfig,
} from '../../platform/provider-routing.js';
import { readVipStrategy } from '../../platform/vip-strategy.js';
import { getCharacterCreatorOwner } from './creator-billing.js';
import { resolveBillingPlan, checkWalletBalance } from './precheck.js';
import type { ResolvedModel, GenerationLogger, GenerationPreparation } from './types.js';
import { getSurplusReasoningParameters } from './surplus-reasoning.js';
import { readChatRecoveryConfig } from './chat-recovery-config.js';

export function prepareGeneration(input: {
  model: ResolvedModel | Promise<ResolvedModel>;
  characterId: string | null;
  useFallback: boolean;
  payer?: { userId: string; chargeId: string; log: GenerationLogger; signal: AbortSignal };
}): Promise<GenerationPreparation> {
  // These reads do not depend on the selected model or on prompt construction.
  // Start them now, rather than introducing another wave after those awaits.
  // Conversation fallback always uses OpenRouter. Other consumers retain lazy
  // routing reads, so a direct Venice request does not gain a needless DB query.
  const routingConfig = input.useFallback ? getProviderRoutingConfig() : undefined;
  // 出字后兜底的配置在出字时才用；这里提前读进缓存，出字时不用等（失败按关闭处理，不影响本轮）。
  if (input.useFallback) void readChatRecoveryConfig();
  const independent = Promise.all([
    getPricingConfig(),
    readVipStrategy(),
    getCharacterCreatorOwner(input.characterId),
  ]);
  const transport = Promise.resolve(input.model).then((model) =>
    resolveTransport(model, input.useFallback, routingConfig)
  );
  const work = Promise.all([independent, transport]).then(
    ([
      [pricing, vipStrategy, creatorUserId],
      {
        model,
        selectedBilling,
        routingModelIds,
        routingPreferences,
        surplusReasoning,
        fallbackSurplusReasoning,
      },
    ]): GenerationPreparation => {
      let paidAdmission: GenerationPreparation['paidAdmission'];
      // Paid admission uses the same frozen quote and exactly one read;
      // no wallet initialization or debit here.
      if (input.payer) {
        input.payer.signal.throwIfAborted();
        const { userId, chargeId, log } = input.payer;
        const plan = resolveBillingPlan({
          chargeId,
          billing: selectedBilling,
          pricing,
          entitlement: model.entitlement,
          discountRate: vipStrategy.discountRate,
          discountConfigVersion: vipStrategy.discountVersion,
          ...(creatorUserId && input.characterId
            ? {
                creator: {
                  characterId: input.characterId,
                  creatorUserId,
                  payerUserId: userId,
                },
              }
            : {}),
          log,
        });
        const balance =
          plan.snapshot.requires_vip && !plan.snapshot.vip_active
            ? Promise.resolve({ ok: true } as const)
            : checkWalletBalance({
                userId,
                requiredAmount: plan.fixedDeduction.amount,
                walletPolicy: plan.snapshot.wallet_policy,
                openRouterModelId: selectedBilling.openRouterModelId,
                log,
              });
        void balance.catch(() => undefined);
        paidAdmission = { userId, plan, balance };
      }
      return {
        modelId: model.modelId,
        provider: model.provider,
        providerModelId: model.providerModelId,
        characterId: input.characterId,
        pricing,
        selectedBilling,
        vipStrategy,
        routingModelIds,
        routingPreferences,
        creatorUserId,
        surplusReasoning,
        fallbackSurplusReasoning,
        paidAdmission,
      };
    }
  );
  // Admission can fail before execute reaches its await. Observe rejection now,
  // while keeping the original rejected promise for the eventual consumer.
  void work.catch(() => undefined);
  return work;
}

/** 模型相关的读取：计费上下文、OpenRouter 供应商偏好、Surplus 思考参数写法（首发与畅聊专用兜底各一份） */
async function resolveTransport(
  model: ResolvedModel,
  useFallback: boolean,
  routingConfig: ReturnType<typeof getProviderRoutingConfig> | undefined
) {
  // 畅聊专用兜底走 Surplus：不读 OpenRouter 供应商偏好，改读兜底模型的思考参数写法
  const surplusFallback =
    useFallback && model.firstTokenPolicy?.fallback?.provider === 'surplus'
      ? model.firstTokenPolicy.fallback.providerModelId
      : undefined;
  const routingModelIds = [
    ...new Set([
      ...(model.provider === 'openrouter' ? [model.providerModelId] : []),
      ...(useFallback && !surplusFallback && model.firstTokenPolicy?.fallbackModelId
        ? [model.firstTokenPolicy.fallbackModelId]
        : []),
    ]),
  ];
  const billing = Promise.resolve(
    model.billingContext ??
      getModelBillingContext({
        provider: model.provider,
        providerModelId: model.providerModelId,
      })
  );
  const [selectedBilling, routingPreferences, surplusReasoning, fallbackSurplusReasoning] =
    await Promise.all([
      billing,
      getProviderPreferencesForModels(routingModelIds, routingConfig),
      model.provider === 'surplus'
        ? getSurplusReasoningParameters(model.providerModelId, true, { cachedOnly: true })
        : undefined,
      surplusFallback
        ? getSurplusReasoningParameters(surplusFallback, true, { cachedOnly: true })
        : undefined,
    ]);
  return {
    model,
    selectedBilling,
    routingModelIds,
    routingPreferences,
    surplusReasoning,
    fallbackSurplusReasoning,
  };
}
