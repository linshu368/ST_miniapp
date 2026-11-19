/**
 * Rich reply protocol v1.
 *
 * This is the version-controlled source for the model-output contract.  Admin
 * defaults and the engine import this value rather than maintaining separate
 * prompt fragments. The fixed grammar is intentionally independent from the
 * operator-managed full/concise copy.
 */
export const RICH_REPLY_PROTOCOL_VERSION = 1;

export const RICH_REPLY_PROTOCOL_INSTRUCTIONS = `# 回复富文本协议（v1，唯一语法要求）

仅输出本轮槽位规则要求开启的模块。开启模块必须按以下相对顺序输出，关闭模块完全省略，且只使用简体中文：

正文 → [choices]

1. 正文正常书写；只有中文引号 “……” 内的对白会被强调展示。
2. choices 必须恰好包含 3 个完整的 [choice]…[/choice]，并用 [choices]…[/choices] 包裹。
3. 不要输出状态栏、记忆区，也不要输出 [status]、[memory] 标记或 <details> 折叠面板。
4. 不要输出协议说明、标签变体、思考过程或代码解释。
5. 开启的模块必须完整闭合。
6. full/concise 槽位文案只决定内容详略；若其中的标签或格式描述与本协议冲突，一律以本协议为准。`;

export const RICH_REPLY_SYSTEM_INSTRUCTIONS = [
  'Roleplay System Instructions',
  '',
  '{{CHOICE_RULES}}',
  '{{STATUS_RULES}}',
  '{{MEMORY_RULES}}',
  '',
  '输出篇幅为 {{WORD_COUNT}} 字，段落之间使用空行隔开，仅使用简体中文。',
  '',
  RICH_REPLY_PROTOCOL_INSTRUCTIONS,
  '',
  '用户个人偏好为：',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
].join('\n');

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
