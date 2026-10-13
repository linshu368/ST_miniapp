/**
 * 普通正文的视觉对齐现有聊天气泡：字号、段落、列表、引用和代码。
 * 用主题变量，不加载字体或图片。按钮和 summary 的 44px 热区写在元素 inline style 上，
 * 这样运营 CSS 盖不过点击区域。
 */
export const BASE_CSS = `
.reply-markdown { font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; }
.reply-markdown p { margin: 0.5em 0; }
.reply-markdown p:first-child { margin-top: 0; }
.reply-markdown p:last-child { margin-bottom: 0; }
.reply-markdown h3 { margin: 0.75em 0 0.25em; font-size: 15px; font-weight: 600; }
.reply-markdown h4 { margin: 0.5em 0 0.25em; font-weight: 600; }
.reply-markdown ul, .reply-markdown ol { margin: 0.5em 0; padding-left: 1.25em; }
.reply-markdown ul { list-style: disc; }
.reply-markdown ol { list-style: decimal; }
.reply-markdown li { margin: 0.125em 0; }
.reply-markdown blockquote { margin: 0.5em 0; padding-left: 0.75em; border-left: 2px solid var(--primary); color: var(--muted-foreground); }
.reply-markdown code { border-radius: 4px; background: var(--muted); padding: 0 0.25em; font-size: 13px; }
.reply-markdown pre { overflow-x: auto; border-radius: 8px; background: var(--muted); padding: 0.75em; }
.reply-markdown pre code { padding: 0; background: transparent; }
.reply-markdown em { color: var(--muted-foreground); }
.reply-markdown button, .reply-markdown summary { touch-action: manipulation; }
`.trim();
