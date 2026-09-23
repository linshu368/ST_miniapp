/**
 * 免费体验仓库
 */

import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMIT,
  FeatureFreeTrialFactSchema,
  FeatureFreeTrialFeatureSchema,
  MAX_FEATURE_FREE_TRIAL_LIMIT,
  parseMediaFeatureFreeTrialLimit,
  summarizeFeatureFreeTrialQuota,
  type FeatureFreeTrialFeature,
  type FeatureFreeTrialQuotaView,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

interface FreeTrialRpcResult {
  ok?: boolean;
  status?: string;
  code?: string;
  message?: string;
  fact?: unknown;
  quota?: unknown;
}

interface FreeTrialFactRow {
  feature: FeatureFreeTrialFeature;
  reference_id: string;
  ordinal: number;
  status: 'reserved' | 'consumed' | 'released';
}

export type FreeTrialReservationResult =
  | {
      ok: true;
      status: 'reserved' | 'already_reserved' | 'already_consumed';
      fact: FreeTrialFactRow;
      quota: FeatureFreeTrialQuotaView;
    }
  | { ok: false; code: string; message: string };

/**
 * 免费体验仓库
 */
export class FeatureFreeTrialRepository {
  private readonly db = getDomainDb('billing');

  /**
   * 查询免费体验额度
   * @param userId 用户 ID
   * @param feature 免费体验特征
   * @returns 免费体验额度
   */
  async quota(
    userId: string,
    feature: FeatureFreeTrialFeature,
    limit = DEFAULT_FEATURE_FREE_TRIAL_LIMIT
  ): Promise<FeatureFreeTrialQuotaView> {
    const resolvedLimit = parseMediaFeatureFreeTrialLimit(limit);
    await this.reclaimExpired(userId, feature);
    const { data, error } = await this.db
      .from('feature_free_trials')
      .select('ordinal,status')
      .eq('user_id', userId)
      .eq('feature', feature);
    if (error) throw new Error(`查询免费体验额度失败：${error.message}`);

    const summarized = summarizeFeatureFreeTrialQuota({
      feature,
      facts: (data ?? []) as Array<{
        ordinal: number;
        status: 'reserved' | 'consumed' | 'released';
      }>,
      limit: resolvedLimit,
      maxLimit: MAX_FEATURE_FREE_TRIAL_LIMIT,
    });
    if (!summarized.ok) {
      throw new Error(`免费体验额度状态异常：${summarized.code}`);
    }
    return summarized.quota;
  }

  /**
   * 预留免费体验额度
   * @param input 预留免费体验额度输入
   * @returns 预留免费体验额度结果
   */
  async reserve(input: {
    userId: string;
    feature: FeatureFreeTrialFeature;
    referenceId: string;
    ttlSeconds?: number;
  }): Promise<FreeTrialReservationResult> {
    const feature = FeatureFreeTrialFeatureSchema.parse(input.feature);
    const { data, error } = await this.db.rpc('reserve_feature_free_trial', {
      p_user_id: input.userId,
      p_feature: feature,
      p_reference_id: input.referenceId,
      p_ttl_seconds: input.ttlSeconds ?? 900,
    });
    if (error) throw new Error(`预留免费体验额度失败：${error.message}`);
    return parseReservationResult(data as FreeTrialRpcResult);
  }

  /**
   * 释放免费体验额度
   * @param input 释放免费体验额度输入
   * @returns 释放免费体验额度结果
   */
  async release(input: {
    userId: string;
    feature: FeatureFreeTrialFeature;
    referenceId: string;
  }): Promise<void> {
    const { error } = await this.db.rpc('release_feature_free_trial', {
      p_user_id: input.userId,
      p_feature: input.feature,
      p_reference_id: input.referenceId,
    });
    if (error) throw new Error(`释放免费体验额度失败：${error.message}`);
  }

  /**
   * 回收过期免费体验额度
   * @param userId 用户 ID
   * @param feature 免费体验特征
   * @returns 回收过期免费体验额度结果
   */
  private async reclaimExpired(userId: string, feature: FeatureFreeTrialFeature): Promise<void> {
    const { error } = await this.db.rpc('reclaim_expired_feature_free_trials', {
      p_user_id: userId,
      p_feature: feature,
    });
    if (error) throw new Error(`回收过期免费体验额度失败：${error.message}`);
  }
}

/**
 * 空免费体验额度
 * @param feature 免费体验特征
 * @returns 空免费体验额度
 */
export function emptyFreeTrialQuota(
  feature: FeatureFreeTrialFeature,
  limit = DEFAULT_FEATURE_FREE_TRIAL_LIMIT
): FeatureFreeTrialQuotaView {
  const resolvedLimit = parseMediaFeatureFreeTrialLimit(limit);
  return {
    feature,
    free_trial_limit: resolvedLimit,
    free_trials_used: 0,
    free_trials_reserved: 0,
    free_trials_remaining: resolvedLimit,
    next_trial_ordinal: 1,
  };
}

/**
 * 解析免费体验预留结果
 * @param value 免费体验预留结果
 * @returns 免费体验预留结果
 */
function parseReservationResult(value: FreeTrialRpcResult): FreeTrialReservationResult {
  if (value.ok === false) {
    return {
      ok: false,
      code: typeof value.code === 'string' ? value.code : 'FEATURE_FREE_TRIAL_INVALID_STATE',
      message: typeof value.message === 'string' ? value.message : 'free trial reservation failed',
    };
  }
  const fact = FeatureFreeTrialFactSchema.parse(value.fact);
  const quota = value.quota
    ? (value.quota as FeatureFreeTrialQuotaView)
    : emptyFreeTrialQuota(fact.feature);
  const status =
    value.status === 'already_reserved' || value.status === 'already_consumed'
      ? value.status
      : 'reserved';
  return { ok: true, status, fact, quota };
}
