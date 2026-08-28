import {
  CHARACTER_FREE_CHAT_QUOTA_LIMIT_CONFIG_KEY,
  DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT,
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  FreeQuotaExhaustedDialogConfigSchema,
  parseCharacterFreeChatQuotaLimit,
  type FreeQuotaExhaustedDialogConfig,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

/** 配置缺失时的兜底值；实际额度请读 getCharacterFreeChatQuotaLimit()。 */
export const CHARACTER_FREE_CHAT_QUOTA_LIMIT = DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT;
export { DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT, CHARACTER_FREE_CHAT_QUOTA_LIMIT_CONFIG_KEY };
export const FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG_KEY = 'miniapp_free_quota_exhausted_dialog_config';

// 与 st-extension 注入端的提取正则同宽度：只要能安全转成 UUID 并参与外键即可，
// 不做版本/变体校验。
const CHARACTER_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isQuotaTrackableCharacterId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CHARACTER_ID_PATTERN.test(value);
}

export function parseFreeQuotaExhaustedDialogConfig(
  value: unknown
): FreeQuotaExhaustedDialogConfig {
  const parsed = FreeQuotaExhaustedDialogConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG;
}

export async function getCharacterFreeChatQuotaLimit(): Promise<number> {
  const { data, error } = await getDomainDb('app_core')
    .from('runtime_config')
    .select('value')
    .eq('key', CHARACTER_FREE_CHAT_QUOTA_LIMIT_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(
      `[free-quota] 读取角色卡免费轮次上限失败，使用默认 ${DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT}：${error.message}`
    );
    return DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT;
  }
  return parseCharacterFreeChatQuotaLimit(data?.value);
}

export async function getFreeQuotaExhaustedDialogConfig(): Promise<FreeQuotaExhaustedDialogConfig> {
  const { data, error } = await getDomainDb('app_core')
    .from('runtime_config')
    .select('value')
    .eq('key', FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[free-quota] 读取额度耗尽提示配置失败，使用默认文案：${error.message}`);
    return DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG;
  }
  return parseFreeQuotaExhaustedDialogConfig(data?.value);
}
