export interface AIProfileConfig {
  id: string;
  provider: string;
  url: string;
  key: string;
  model: string;
  firstchunk_timeout?: number;
  total_timeout?: number;
}

export type AIChannelConfig = Record<string, AIProfileConfig[]>;
export type TierMappingConfig = Record<string, string>;

export interface AIConfigSourceData {
  channels: AIChannelConfig;
  tier_mapping: TierMappingConfig;
  tier_costs?: Record<string, number>;
}
