/**
 * backend / features / generation / quota.ts
 *
 * 角色卡免费额度的预留与终结（M3a）。搬自 routes/llm-proxy.ts 原第 355~445 行，
 * 分支、日志事件名与字段逐条对照原 handler，行为零变化。
 *
 * 两阶段：生成前 reserve 占一轮，流终态 finalize 决定这一轮算消耗还是退回。
 * 预留结果会改写本轮生效倍率（effectiveModelMarkup），而定档扣费额又由生效倍率决定，
 * 所以调用顺序固定为 reserve → resolveBillingPlan → 余额预检。
 */

import {
  MiniappCharacterFreeQuotaRepository,
  type CharacterFreeQuotaDecision,
} from '../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js';
import {
  getCharacterFreeChatQuotaLimit,
  isQuotaTrackableCharacterId,
  resolveEffectiveModelMarkup,
} from '../billing/free-quota.js';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import type { GenerationLogger } from './types.js';

let freeQuotaRepository: MiniappCharacterFreeQuotaRepository | null = null;

function freeQuotas(): MiniappCharacterFreeQuotaRepository {
  return (freeQuotaRepository ??= new MiniappCharacterFreeQuotaRepository());
}

export interface FreeQuotaReservation {
  /** 本轮实际生效的模型倍率：免费轮为 0，额度耗尽后为 deduct_markup，付费模型恒等于默认倍率 */
  effectiveModelMarkup: number;
  /** 是否真的占用了一轮免费额度。为 false 时 finalize 是 no-op */
  granted: boolean;
  finalize(success: boolean): Promise<CharacterFreeQuotaDecision | null>;
}

/** 不进免费额度体系时的空预留（付费模型 / 非对话请求 / simulation）。 */
export function noFreeQuotaReservation(modelMarkup: number): FreeQuotaReservation {
  return {
    effectiveModelMarkup: modelMarkup,
    granted: false,
    finalize: async () => null,
  };
}

/**
 * 预留一轮角色卡免费额度。
 *
 * 预留失败会抛出——原 handler 在这里返回 500，调用方沿用即可。
 */
export async function reserveCharacterFreeQuota(input: {
  chargeId: string;
  userId: string;
  characterId: string | null;
  billing: Pick<ModelBillingContext, 'modelMarkup' | 'deductMarkup'>;
  log: GenerationLogger;
}): Promise<FreeQuotaReservation> {
  const { chargeId, userId, billing, log } = input;

  if (billing.modelMarkup !== 0) return noFreeQuotaReservation(billing.modelMarkup);

  if (!isQuotaTrackableCharacterId(input.characterId)) {
    // 轮次无法归属到角色卡时不判定为免费轮，按额度耗尽后的倍率计费并放行：
    // character_id 一直是可选输入，免费模型不应因为它缺失而完全无法对话。
    const effectiveModelMarkup = resolveEffectiveModelMarkup(
      billing.modelMarkup,
      billing.deductMarkup,
      false
    );
    log.biz.warn(
      {
        event: 'llm.free_quota.skipped_untrackable_character',
        userId,
        characterId: input.characterId,
        chargeId,
        effectiveMarkup: effectiveModelMarkup,
      },
      'free quota skipped: character id missing or unusable'
    );
    return { effectiveModelMarkup, granted: false, finalize: async () => null };
  }

  const characterId = input.characterId;
  try {
    const quotaLimit = await getCharacterFreeChatQuotaLimit();
    const quotaDecision = await freeQuotas().reserve({
      chargeId,
      userId,
      characterId,
      quotaLimit,
    });
    const effectiveModelMarkup = resolveEffectiveModelMarkup(
      billing.modelMarkup,
      billing.deductMarkup,
      quotaDecision.grantedFree
    );
    log.biz.info(
      {
        event: 'llm.free_quota.decision',
        userId,
        characterId,
        chargeId,
        grantedFree: quotaDecision.grantedFree,
        remainingRounds: quotaDecision.remainingRounds,
        quotaLimit,
        effectiveMarkup: effectiveModelMarkup,
      },
      'character free quota decision resolved'
    );

    if (!quotaDecision.grantedFree) {
      return { effectiveModelMarkup, granted: false, finalize: async () => null };
    }
    return {
      effectiveModelMarkup,
      granted: true,
      finalize: (success) => finalizeReservation({ chargeId, userId, characterId, success, log }),
    };
  } catch (err) {
    log.sys.error(
      { event: 'llm.free_quota.reserve_failed', err, userId, characterId, chargeId },
      'failed to reserve character free quota'
    );
    throw err;
  }
}

/** 终结失败不影响用户请求：与原 handler 一致，只记日志并返回 null。 */
async function finalizeReservation(input: {
  chargeId: string;
  userId: string;
  characterId: string;
  success: boolean;
  log: GenerationLogger;
}): Promise<CharacterFreeQuotaDecision | null> {
  const { chargeId, userId, characterId, success, log } = input;
  try {
    const result = await freeQuotas().finalize(chargeId, success);
    log.biz.info(
      {
        event: 'llm.free_quota.finalized',
        userId,
        characterId,
        chargeId,
        success,
        usedRounds: result.usedRounds,
        justExhausted: result.justExhausted,
      },
      'character free quota reservation finalized'
    );
    return result;
  } catch (err) {
    log.sys.error(
      { event: 'llm.free_quota.finalize_failed', err, userId, characterId, chargeId, success },
      'failed to finalize character free quota'
    );
    return null;
  }
}
