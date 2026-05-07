import { runtimeConfigService } from '../../services/RuntimeConfigService.js';

export enum ModelTier {
  TIER_1 = 'tier_1',
  TIER_2 = 'tier_2',
  TIER_3 = 'tier_3',
  TIER_4 = 'tier_4',
}

export async function resolveChannelId(tier: ModelTier): Promise<string> {
  const config = await runtimeConfigService.getAiConfigSource();
  return config.tier_mapping?.[tier] || 'channel_default';
}
