import type { ChatEngineMode } from '@miniapp/shared';

interface ChatEntryOptions {
  /** 自研链路：继续某个已有会话 */
  sessionId?: string;
  /** ST 链路：继续某个 ST chat 文件 */
  legacyChatFile?: string;
}

/**
 * 聊天入口的目标路由。开关未解析（undefined）时按 ST 处理，见 useChatEngineMode 的说明。
 *
 * 两条链路的「继续上次对话」参数互不通用，所以按模式各带各的：ST 认 chat 文件名，
 * 自研链路认 chat_sessions 的 id。
 */
export function chatEntryPath(
  mode: ChatEngineMode | undefined,
  characterId: string,
  options: ChatEntryOptions = {}
): string {
  const id = encodeURIComponent(characterId);

  if (mode === 'self_hosted') {
    const search = options.sessionId
      ? `?${new URLSearchParams({ session: options.sessionId }).toString()}`
      : '';
    return `/chat/${id}${search}`;
  }

  const search = options.legacyChatFile
    ? `?${new URLSearchParams({ chat: options.legacyChatFile }).toString()}`
    : '';
  return `/tavern/${id}${search}`;
}
