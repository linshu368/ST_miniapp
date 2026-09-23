import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMIT,
  MEDIA_FEATURE_FREE_TRIAL_LIMIT_CONFIG_KEY,
  parseMediaFeatureFreeTrialLimit,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';

export async function getMediaFeatureFreeTrialLimit(): Promise<number> {
  const entry = await fetchRuntimeConfigEntry(MEDIA_FEATURE_FREE_TRIAL_LIMIT_CONFIG_KEY);
  return parseMediaFeatureFreeTrialLimit(entry?.value ?? DEFAULT_FEATURE_FREE_TRIAL_LIMIT);
}
