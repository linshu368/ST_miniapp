/**
 * 客服红点只看「最后一条客服回复」和「用户最后一次打开聊天页」的先后，
 * 不维护计数器，避免多端或重试时计数漂移导致红点残留。
 */
export function hasUnreadAgentReply(
  lastAgentMessageAt: string | null | undefined,
  userLastReadAt: string | null | undefined
): boolean {
  if (!lastAgentMessageAt) return false;
  const repliedAt = Date.parse(lastAgentMessageAt);
  if (Number.isNaN(repliedAt)) return false;
  if (!userLastReadAt) return true;
  const readAt = Date.parse(userLastReadAt);
  if (Number.isNaN(readAt)) return true;
  return repliedAt > readAt;
}
