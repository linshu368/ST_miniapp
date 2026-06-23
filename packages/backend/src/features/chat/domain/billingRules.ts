import { getSupabaseClient } from '../../../lib/supabase.js';
import { ModelTier } from '../../../ai/domain/ModelStrategy.js';

export const CHAT_MESSAGE_CREDIT_COST_KEY = 'miniapp_chat_message_credit_cost';
export const MODEL_TIER_CREDIT_COSTS_KEY = 'miniapp_model_tier_credit_costs';
const DEFAULT_CHAT_MESSAGE_CREDIT_COST = 1;
const DEFAULT_MODEL_TIER_CREDIT_COSTS: Record<ModelTier, number> = {
  [ModelTier.TIER_1]: 1,
  [ModelTier.TIER_2]: 2,
  [ModelTier.TIER_3]: 4,
  [ModelTier.TIER_4]: 8,
};

export async function getChatMessageCreditCost(tier: ModelTier): Promise<number> {
  const db = getSupabaseClient().schema('miniapp');
  const { data: tierData, error: tierError } = await db
    .from('runtime_config')
    .select('value, text_value')
    .eq('key', MODEL_TIER_CREDIT_COSTS_KEY)
    .maybeSingle();

  if (tierError) {
    console.warn(`[chat] 读取模型档次扣费配置失败，尝试旧配置：${tierError.message}`);
  } else {
    const tierCosts = parseTierCosts(tierData?.value ?? tierData?.text_value);
    const tierCost = tierCosts?.[tier];
    if (tierCost !== undefined) return tierCost;
  }

  const { data, error } = await db
    .from('runtime_config')
    .select('value, text_value')
    .eq('key', CHAT_MESSAGE_CREDIT_COST_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[chat] 读取扣费配置失败，使用默认值：${error.message}`);
    return DEFAULT_CHAT_MESSAGE_CREDIT_COST;
  }

  const parsed = parseCreditCost(data?.value ?? data?.text_value);
  return parsed ?? DEFAULT_CHAT_MESSAGE_CREDIT_COST;
}

function parseTierCosts(value: unknown): Partial<Record<ModelTier, number>> | null {
  const raw = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const result: Partial<Record<ModelTier, number>> = {};
  for (const tier of Object.values(ModelTier)) {
    const parsed = parseCreditCost((raw as Record<string, unknown>)[tier]);
    if (parsed !== null) result[tier] = parsed;
  }

  return Object.keys(result).length > 0 ? result : DEFAULT_MODEL_TIER_CREDIT_COSTS;
}

function parseCreditCost(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  // 0 means free-chat mode; request idempotency is still enforced by chat_message_charges.
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
