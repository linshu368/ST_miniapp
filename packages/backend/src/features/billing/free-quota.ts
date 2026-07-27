import {
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  FreeQuotaExhaustedDialogConfigSchema,
  type FreeQuotaExhaustedDialogConfig,
} from '@miniapp/shared';
import { getSupabaseClient } from '../../lib/supabase.js';

export const CHARACTER_FREE_CHAT_QUOTA_LIMIT = 50;
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

export async function getFreeQuotaExhaustedDialogConfig(): Promise<FreeQuotaExhaustedDialogConfig> {
  const { data, error } = await getSupabaseClient()
    .schema('miniapp')
    .from('runtime_config')
    .select('value')
    .eq('key', FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG_KEY)
    .maybeSingle();

  if (error) {
    console.warn(`[free-quota] 读取额度耗尽弹窗配置失败，使用默认文案：${error.message}`);
    return DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG;
  }
  return parseFreeQuotaExhaustedDialogConfig(data?.value);
}

export function resolveEffectiveModelMarkup(
  defaultMarkup: number,
  deductMarkup: number,
  freeQuotaGranted: boolean | null
): number {
  if (defaultMarkup > 0) return defaultMarkup;
  return freeQuotaGranted === false ? deductMarkup : 0;
}
