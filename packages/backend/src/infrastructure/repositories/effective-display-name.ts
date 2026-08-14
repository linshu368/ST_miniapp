import { DEFAULT_USER_DISPLAY_NAME } from '@miniapp/shared';

/**
 * 「我的」页展示名口径：自定义 display_name > TG first_name > TG username > 「你」。
 * 不拼 last_name，与前端 getTelegramDefaultDisplayName 一致。
 */
export function resolveEffectiveDisplayName(
  row: {
    display_name: string | null;
    tg_first_name: string | null;
    tg_username: string | null;
  } | null
): string {
  if (!row) return DEFAULT_USER_DISPLAY_NAME;
  return (
    row.display_name?.trim() ||
    row.tg_first_name?.trim() ||
    row.tg_username?.trim() ||
    DEFAULT_USER_DISPLAY_NAME
  );
}
