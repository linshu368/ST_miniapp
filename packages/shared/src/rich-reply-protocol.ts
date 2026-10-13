/**
 * Rich reply protocol v1.
 *
 * This is the version-controlled source for the model-output contract.  Admin
 * defaults and the engine fallback import this value rather than maintaining
 * separate prompt fragments.  The parser deliberately treats malformed
 * modules as ordinary text, so an incomplete model reply never loses content.
 */
export const RICH_REPLY_PROTOCOL_VERSION = 1;

export const RICH_REPLY_PROTOCOL_INSTRUCTIONS = `# 回复富文本协议（v1）

每次回复都必须按以下顺序输出，且只使用简体中文：

正文 → [choices] → [status] → [memory]

1. 正文正常书写；只有中文引号 “……” 内的对白会被强调展示。
2. choices 必须恰好包含 3 个完整的 [choice]…[/choice]，并用 [choices]…[/choices] 包裹。
3. status 必须用 [status]…[/status] 包裹；其中每个面板都使用：
   <details><summary>标题</summary>\n\n\`\`\`markdown\n字段：内容\n\`\`\`\n</details>
4. memory 必须用 [memory]…[/memory] 包裹，并沿用 status 的面板格式。
5. 不要输出协议说明、HTML 以外的标签变体、思考过程或代码解释。
6. 三个模块必须完整闭合。若信息暂时为空，仍输出对应模块和简短的“暂无”内容。`;

export const RICH_REPLY_SYSTEM_INSTRUCTIONS = [
  'Roleplay System Instructions',
  '',
  '输出篇幅为 {{WORD_COUNT}} 字，段落之间使用空行隔开，仅使用简体中文。',
  '',
  RICH_REPLY_PROTOCOL_INSTRUCTIONS,
  '',
  '用户个人偏好为：',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
].join('\n');
