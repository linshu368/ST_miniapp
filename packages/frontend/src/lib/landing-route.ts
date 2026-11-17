/**
 * 冷启动落地页：有对话记录的用户从 `/` 直接进「对话」，其余进秘境（角色大厅）。
 *
 * next.config 按 cookie rewrite，无额外文档跳转；启动参数捕获后再规范 URL。
 * cookie 只说明「这台设备上次看到过对话记录」：读到会话列表或会话详情时
 * 顺手校正，判断错了最多落到另一个一级页面，底栏一下就能切回去。
 * 名称和取值必须与 next.config.mjs 里的条件保持一致。
 */
export const CHAT_LANDING_COOKIE = 'st_landing';
const CHAT_LANDING_VALUE = 'chats';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Only root is an alias; the actual router tree, not a mutable cookie, owns its page. */
export function entryPathname(pathname: string, segments: readonly string[]): string {
  if (pathname !== '/') return pathname;
  const route = segments.filter((segment) => !segment.startsWith('('));
  return route.length === 1 && (route[0] === 'chats' || route[0] === 'characters')
    ? `/${route[0]}`
    : pathname;
}

/** Call after launch capture and Next's passive effects; never causes a document fetch. */
export function canonicalizeLandingPath(pathname: string): boolean {
  if (typeof window === 'undefined' || window.location.pathname !== '/') return true;
  if (pathname !== '/chats' && pathname !== '/characters') return true;
  try {
    // Next copies its internal tree into null state and synchronizes usePathname.
    // Passing history.state would carry __NA and bypass synchronization in Next14.
    window.history.replaceState(null, '', pathname + window.location.search + window.location.hash);
    return true;
  } catch {
    return false;
  }
}

export function rememberChatLanding(hasConversations: boolean): void {
  if (typeof document === 'undefined') return;
  try {
    const current = document.cookie
      .split('; ')
      .includes(`${CHAT_LANDING_COOKIE}=${CHAT_LANDING_VALUE}`);
    if (current === hasConversations) return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = hasConversations
      ? `${CHAT_LANDING_COOKIE}=${CHAT_LANDING_VALUE}; Max-Age=${ONE_YEAR_SECONDS}; Path=/; SameSite=Lax${secure}`
      : `${CHAT_LANDING_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  } catch {
    // 沙箱 iframe（如网页版 Telegram）可能禁写 cookie；落地页退回秘境即可。
  }
}
