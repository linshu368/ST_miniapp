import DOMPurify, { type Config as SanitizeConfig } from 'dompurify';
import { Converter } from 'showdown';

/**
 * 与聊天气泡相同的 Showdown 选项。Showdown 2.1 没有内置 safeMode 开关；
 * 这里的 output filter 只去掉明显的脚本容器，真正的白名单仍是后面的 DOMPurify。
 * 官方说明 Showdown 不是 sanitizer，所以不能拿这个 filter 代替净化。
 */
const converter = new Converter({
  simpleLineBreaks: true,
  strikethrough: true,
  literalMidWordUnderscores: true,
  tables: false,
  ghCodeBlocks: true,
  noHeaderId: true,
  simplifiedAutoLink: false,
  openLinksInNewWindow: false,
  ghMentions: false,
  emoji: false,
  extensions: [
    {
      type: 'output',
      filter: (html: string) =>
        html
          .replace(
            /<\/?(?:script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*>/gi,
            ''
          )
          .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
    },
  ],
});

const SANITIZE_OPTIONS: SanitizeConfig = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'h3',
    'h4',
    'hr',
  ],
  ALLOWED_ATTR: [],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  KEEP_CONTENT: true,
};

const MARKDOWN_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h3',
  'h4',
  'hr',
]);

/** 整段正文只解析一次。槽位 token 已经在调用前写进这份 Markdown。 */
export function renderMarkdownHtml(markdown: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return '';
  const html = converter.makeHtml(markdown);
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
}

export function parseMarkdownDocument(html: string): HTMLElement | null {
  if (typeof DOMParser === 'undefined') return null;
  const document = new DOMParser().parseFromString(
    `<div id="reply-root">${html}</div>`,
    'text/html'
  );
  const root = document.getElementById('reply-root');
  return root;
}

export function isMarkdownTag(tag: string): boolean {
  return MARKDOWN_TAGS.has(tag);
}
