import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
} from '@miniapp/shared';
import type { VipStrategy } from '../../platform/vip-strategy.js';

vi.mock('../../platform/vip-strategy.js', () => ({
  readVipStrategy: vi.fn(),
}));

import { getPublishedFeatureFreeTrialLimit } from './feature-free-trial-limit.js';
import { readVipStrategy } from '../../platform/vip-strategy.js';
import { emptyFreeTrialQuota } from '../../infrastructure/repositories/FeatureFreeTrialRepository.js';
import { emptyBasicImageFreeTrialQuotaForLimit } from '../image/config.js';

function strategy(limits: { voice: number; basic_image: number }): VipStrategy {
  return {
    purchaseEnabled: false,
    remindersEnabled: false,
    plans: structuredClone(DEFAULT_VIP_PLANS_CONFIG),
    plansVersion: 1,
    discountRate: DEFAULT_VIP_TEXT_DISCOUNT_RATE,
    discountVersion: 1,
    checkin: structuredClone(DEFAULT_VIP_CHECKIN_BONUS_CONFIG),
    checkinVersion: 1,
    limits,
    limitsVersion: 1,
    fallbacks: [],
  };
}

describe('getPublishedFeatureFreeTrialLimit', () => {
  beforeEach(() => {
    vi.mocked(readVipStrategy).mockReset();
  });

  it('reads voice and basic_image from the published VIP strategy separately', async () => {
    vi.mocked(readVipStrategy).mockResolvedValue(strategy({ voice: 0, basic_image: 4 }));

    await expect(getPublishedFeatureFreeTrialLimit('voice')).resolves.toBe(0);
    await expect(getPublishedFeatureFreeTrialLimit('basic_image')).resolves.toBe(4);
    expect(readVipStrategy).toHaveBeenCalledTimes(2);
  });
});

describe('empty free-trial quota', () => {
  it('keeps a closed limit at zero instead of restoring the default of 3', () => {
    expect(emptyFreeTrialQuota('voice', 0)).toMatchObject({
      free_trial_limit: 0,
      free_trials_remaining: 0,
      next_trial_ordinal: null,
    });
    expect(emptyBasicImageFreeTrialQuotaForLimit(0)).toMatchObject({
      feature: 'basic_image',
      free_trial_limit: 0,
      free_trials_remaining: 0,
      next_trial_ordinal: null,
    });
    expect(emptyFreeTrialQuota('basic_image', 21).free_trial_limit).toBe(3);
  });
});
