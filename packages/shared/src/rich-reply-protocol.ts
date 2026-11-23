/**
 * Rich reply protocol v2.
 *
 * This is the version-controlled source for the model-output contract.  Admin
 * defaults and the engine import this value rather than maintaining separate
 * prompt fragments. The fixed grammar is intentionally independent from the
 * operator-managed full/concise copy.
 */
export const RICH_REPLY_PROTOCOL_VERSION = 2;

/**
 * 正文模型只写剧情正文和选项：状态栏、记忆栏都由独立模型记录、聊天页右侧面板展示。
 * 对白格式由运营托管的主体模板规定，这里不重复。
 */
export const RICH_REPLY_PROTOCOL_INSTRUCTIONS = `# 回复富文本协议（v2，唯一语法要求）

整条回复只有剧情正文和选项两部分，只使用简体中文：正文在前；本轮选项开启时，正文后面接一组选项，选项关闭时完全省略。

选项恰好包含 3 个完整的 [choice]…[/choice]，用 [choices]…[/choices] 包裹，标签完整闭合。`;

/** Only the prose before auxiliary panels is editable. Keep the protected tail byte-for-byte. */
export function splitEditableReply(content: string): { body: string; protectedTail: string } {
  const marker =
    /\[\s*\/?\s*(?:choices?|status|memory)\s*\]|<\/?(?:choices?|status|memory|details)\b[^>]*>/i.exec(
      content
    );
  if (!marker) return { body: content, protectedTail: '' };
  let boundary = marker.index;
  // A fenced module belongs to the panel, not to the user's prose.
  const fence = /(?:^|\r?\n)[ \t]*(?:`{3,}|~{3,})[^\r\n]*\r?\n[ \t]*$/.exec(
    content.slice(0, boundary)
  );
  if (fence) boundary = fence.index;
  while (boundary > 0 && /\s/.test(content[boundary - 1]!)) boundary -= 1;
  return { body: content.slice(0, boundary), protectedTail: content.slice(boundary) };
}

const LEGACY_STATUS_BLOCK =
  /[[【［]\s*status\s*[\]】］][\s\S]*?(?:[[【［]\s*\/\s*status\s*[\]】］]|(?=[[【［]\s*memory\s*[\]】］])|$)/gi;
const LEGACY_MEMORY_BLOCK =
  /[[【［]\s*memory\s*[\]】］][\s\S]*?(?:[[【［]\s*\/\s*memory\s*[\]】］]|$)/gi;

/**
 * 旧版状态栏、记忆栏（正文末尾的 [status]、[memory] 块）在纯文本显示和回喂正文模型时直接去掉；
 * 两者都改由独立模型记录、聊天页右侧面板展示。
 */
export function stripLegacyPanelBlocks(content: string): string {
  if (!/status|memory/i.test(content)) return content;
  return content
    .replace(LEGACY_STATUS_BLOCK, '')
    .replace(LEGACY_MEMORY_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
