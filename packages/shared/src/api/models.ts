export interface ModelTierConfig {
  tier: string;
  modelName: string;
  provider: string;
  label: string;
  deductionRate: number;
  isDefault?: boolean;
}

export interface GetModelTiersData {
  tiers: ModelTierConfig[];
}
