import { runtimeConfigService } from '../../services/RuntimeConfigService.js';

export enum ModelTier {
  FREE = 'free',
  VIP = 'vip',
}

export async function resolveChannelId(tier: ModelTier): Promise<string> {
  const config = await runtimeConfigService.getAiConfigSource();
  return config.tier_mapping?.[tier] || 'channel_default';
}
