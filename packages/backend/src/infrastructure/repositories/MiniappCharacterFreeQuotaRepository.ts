import { getDomainDb } from '../../lib/supabase.js';

interface CharacterFreeQuotaRpcResult {
  granted_free: boolean;
  status: 'reserved' | 'consumed' | 'released' | 'paid';
  used_rounds: number;
  remaining_rounds: number;
  just_exhausted?: boolean;
}

export interface CharacterFreeQuotaDecision {
  grantedFree: boolean;
  status: CharacterFreeQuotaRpcResult['status'];
  usedRounds: number;
  remainingRounds: number;
  justExhausted: boolean;
}

export class MiniappCharacterFreeQuotaRepository {
  private readonly db = getDomainDb('billing');

  async getStatus(
    userId: string,
    characterId: string,
    quotaLimit: number
  ): Promise<{ usedRounds: number; remainingRounds: number; exhausted: boolean }> {
    const { data, error } = await this.db
      .from('character_free_chat_quotas')
      .select('used_rounds')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .maybeSingle();
    if (error) throw new Error(`查询角色卡免费轮次失败：${error.message}`);
    const usedRounds = Number((data as { used_rounds?: number } | null)?.used_rounds ?? 0);
    return {
      usedRounds,
      remainingRounds: Math.max(quotaLimit - usedRounds, 0),
      exhausted: usedRounds >= quotaLimit,
    };
  }

  async reserve(input: {
    chargeId: string;
    userId: string;
    characterId: string;
    quotaLimit: number;
  }): Promise<CharacterFreeQuotaDecision> {
    const { data, error } = await this.db.rpc('reserve_character_free_chat_round', {
      p_charge_key: input.chargeId,
      p_user_id: input.userId,
      p_character_id: input.characterId,
      p_quota_limit: input.quotaLimit,
    });
    if (error) throw new Error(`预留角色卡免费轮次失败：${error.message}`);
    return normalizeDecision(data);
  }

  async finalize(chargeId: string, success: boolean): Promise<CharacterFreeQuotaDecision> {
    const { data, error } = await this.db.rpc('finalize_character_free_chat_round', {
      p_charge_key: chargeId,
      p_success: success,
    });
    if (error) throw new Error(`确认角色卡免费轮次失败：${error.message}`);
    return normalizeDecision(data);
  }

  /**
   * 同步任务并不知道本轮是否进入了免费额度体系；只在确有预留时终结，
   * 付费模型和已终结的决定均保持 no-op。
   */
  async finalizePending(
    chargeId: string,
    success: boolean
  ): Promise<CharacterFreeQuotaDecision | null> {
    const { data, error } = await this.db
      .from('character_free_chat_quota_decisions')
      .select('status')
      .eq('charge_key', chargeId)
      .maybeSingle();
    if (error) throw new Error(`查询角色卡免费轮次决定失败：${error.message}`);
    if ((data as { status?: string } | null)?.status !== 'reserved') return null;
    return this.finalize(chargeId, success);
  }
}

function normalizeDecision(value: unknown): CharacterFreeQuotaDecision {
  if (!value || typeof value !== 'object') {
    throw new Error('角色卡免费轮次结果无效');
  }
  const result = value as Partial<CharacterFreeQuotaRpcResult>;
  if (
    typeof result.granted_free !== 'boolean' ||
    !['reserved', 'consumed', 'released', 'paid'].includes(result.status ?? '') ||
    typeof result.used_rounds !== 'number' ||
    typeof result.remaining_rounds !== 'number'
  ) {
    throw new Error('角色卡免费轮次结果字段不完整');
  }
  return {
    grantedFree: result.granted_free,
    status: result.status as CharacterFreeQuotaRpcResult['status'],
    usedRounds: result.used_rounds,
    remainingRounds: result.remaining_rounds,
    justExhausted: result.just_exhausted === true,
  };
}
