interface ChatEntryOptions {
  /** 继续某个已有会话 */
  sessionId?: string;
}

/**
 * 聊天入口的目标路由。自研链路认 chat_sessions 的 id。
 */
export function chatEntryPath(characterId: string, options: ChatEntryOptions = {}): string {
  const id = encodeURIComponent(characterId);
  const search = options.sessionId
    ? `?${new URLSearchParams({ session: options.sessionId }).toString()}`
    : '';
  return `/chat/${id}${search}`;
}

/**
 * 「自定义本次语音」页的路由。
 *
 * session 单独带一份而不是从 returnTo 里解析：那个页面要用会话 id 拉语音、发生成请求，
 * 把它藏在另一个 URL 里等着被解析，往后改 returnTo 的格式就会静默断掉。
 */
export function customVoicePath(
  characterId: string,
  messageId: string,
  options: { sessionId: string; returnTo: string }
): string {
  const search = new URLSearchParams({
    session: options.sessionId,
    returnTo: options.returnTo,
  });
  return `/chat/${encodeURIComponent(characterId)}/voice/${encodeURIComponent(
    messageId
  )}?${search.toString()}`;
}
