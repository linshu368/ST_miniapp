import { getSupabaseClient } from '../../../lib/supabase.js';

export const CHAT_MESSAGE_CREDIT_COST_KEY = 'miniapp_chat_message_credit_cost';
const DEFAULT_CHAT_MESSAGE_CREDIT_COST = 1;

export async function getChatMessageCreditCost(): Promise<number> {
  const db = getSupabaseClient().schema('miniapp');
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

function parseCreditCost(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}
