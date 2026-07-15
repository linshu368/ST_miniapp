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

export interface InsufficientBalanceErrorResponse {
  error: {
    message: string;
    type: 'insufficient_balance';
    credits_required: number;
    credits_available: number;
  };
}
