/**
 * 冷启动落地页：有对话记录的用户从 `/` 直接进「对话」，其余进秘境（角色大厅）。
 *
 * 跳转在 next.config 的 redirects 里按这个 cookie 判断，Vercel 边缘每次请求都会重新判断，
 * 不多一次跳转、不用等 JS。cookie 只说明「这台设备上次看到过对话记录」：读到会话列表或会话详情时
 * 顺手校正，判断错了最多落到另一个一级页面，底栏一下就能切回去。
 * 名称和取值必须与 next.config.mjs 里的条件保持一致。
 */
export const CHAT_LANDING_COOKIE = 'st_landing';
const CHAT_LANDING_VALUE = 'chats';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

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
