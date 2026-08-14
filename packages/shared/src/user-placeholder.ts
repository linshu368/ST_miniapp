/**
 * 酒馆角色卡常用的 {{user}} 宏。自研引擎不做完整宏体系，只替换这一处，
 * 口径对齐「我的」页生效显示名。
 *
 * 替换必须走函数式 replacement：显示名是用户自由文本，字符串 replacement
 * 会把 `$&` / `$1` 当成模式展开。
 */
export const DEFAULT_USER_DISPLAY_NAME = '你';

const USER_PLACEHOLDER = '{{user}}';

export function replaceUserPlaceholder(
  text: string,
  displayName: string | null | undefined
): string {
  if (!text.includes(USER_PLACEHOLDER)) return text;
  const name = displayName?.trim() || DEFAULT_USER_DISPLAY_NAME;
  return text.replace(/\{\{user\}\}/g, () => name);
}
