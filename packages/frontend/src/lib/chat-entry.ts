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
