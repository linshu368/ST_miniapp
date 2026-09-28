import type { FeatureFreeTrialFeature } from '@miniapp/shared';
import { readVipStrategy } from '../../platform/vip-strategy.js';

/**
 * 语音和初级图片各自读取已发布的 feature_free_trial_limits。
 * 不读 media_feature_free_trial_limit：那是并行旧键，不能再决定是否免费。
 */
export async function getPublishedFeatureFreeTrialLimit(
  feature: FeatureFreeTrialFeature
): Promise<number> {
  const strategy = await readVipStrategy();
  return strategy.limits[feature];
}
