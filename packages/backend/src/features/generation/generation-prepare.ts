import { getModelBillingContext } from '../../platform/model-tiers.js';
import { getPricingConfig } from '../../platform/model-tiers.js';
import {
  getProviderPreferencesForModels,
  getProviderRoutingConfig,
} from '../../platform/provider-routing.js';
import { readVipStrategy } from '../../platform/vip-strategy.js';
import { getCharacterCreatorOwner } from './creator-billing.js';
import {
  getCharacterFreeChatQuotaLimit,
  isQuotaTrackableCharacterId,
} from '../billing/free-quota.js';
import { resolveBillingPlan, checkWalletBalance } from './precheck.js';
import type { ResolvedModel, GenerationLogger, GenerationPreparation } from './types.js';
import { getSurplusReasoningParameters } from './surplus-reasoning.js';

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
  const independent = Promise.all([
    getPricingConfig(),
    readVipStrategy(),
    getCharacterCreatorOwner(input.characterId),
  ]);
  const transport = Promise.resolve(input.model).then(async (model) => {
    const routingModelIds = [
      ...new Set([
        ...(model.provider === 'openrouter' ? [model.providerModelId] : []),
        ...(input.useFallback && model.firstTokenPolicy?.fallbackModelId
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
    const [selectedBilling, routingPreferences, quotaLimit, surplusReasoning] = await Promise.all([
      billing,
      getProviderPreferencesForModels(routingModelIds, routingConfig),
      billing.then((value) =>
        value.isFree && isQuotaTrackableCharacterId(input.characterId)
          ? getCharacterFreeChatQuotaLimit()
          : undefined
      ),
      model.provider === 'surplus'
        ? getSurplusReasoningParameters(model.providerModelId, true, { cachedOnly: true })
        : undefined,
    ]);
    return {
      model,
      selectedBilling,
      routingModelIds,
      routingPreferences,
      quotaLimit,
      surplusReasoning,
    };
  });
  const work = Promise.all([independent, transport]).then(
    ([
      [pricing, vipStrategy, creatorUserId],
      { model, selectedBilling, routingModelIds, routingPreferences, quotaLimit, surplusReasoning },
    ]): GenerationPreparation => {
      let paidAdmission: GenerationPreparation['paidAdmission'];
      // Never speculate on free quota. Paid admission uses the same frozen quote
      // and exactly one read; no reservation, wallet initialization or debit here.
      if (input.payer && !selectedBilling.isFree) {
        input.payer.signal.throwIfAborted();
        const { userId, chargeId, log } = input.payer;
        const plan = resolveBillingPlan({
          chargeId,
          billing: selectedBilling,
          isFreeRound: false,
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
        quotaLimit,
        surplusReasoning,
        paidAdmission,
      };
    }
  );
  // Admission can fail before execute reaches its await. Observe rejection now,
  // while keeping the original rejected promise for the eventual consumer.
  void work.catch(() => undefined);
  return work;
}
