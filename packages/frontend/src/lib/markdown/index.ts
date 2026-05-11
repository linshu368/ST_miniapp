// SillyTavern 风格的 LLM 输出文本渲染管线(简化版)
// 输入:LLM 原始文本(可含 markdown / 引号 / {{user}} / {{char}} / <style> 等)
// 输出:可安全注入 dangerouslySetInnerHTML 的 HTML 字符串

import { getConverter } from './converter';
import { substituteMacros, type MacroContext } from './macros';
import { wrapQuotes } from './quote-wrap';
import { sanitizeHtml } from './sanitize';
import { decodeStyleTags, encodeStyleTags } from './style-tags';

export interface FormatMessageOptions extends MacroContext {
  text: string;
}

/** 宏已替换后的片段 → HTML（供对白/旁白分段复用） */
function runMarkdownPipeline(mes: string): string {
  let m = mes;
  m = wrapQuotes(m);

  m = m.replaceAll('\\begin{align*}', '$$');
  m = m.replaceAll('\\end{align*}', '$$');

  m = getConverter().makeHtml(m);

  m = m.replace(/<code(.*?)>[\s\S]*?<\/code>/g, (block) => block.replace(/\n/gm, '\u0000'));
  m = m.replace(/\u0000/g, '\n');
  m = m.trim();

  m = m.replace(/<code(.*?)>[\s\S]*?<\/code>/g, (block) => block.replace(/&amp;/g, '&'));

  m = encodeStyleTags(m);
  m = sanitizeHtml(m);
  m = decodeStyleTags(m, { prefix: '.mes-text ' });

  return m;
}

export function formatMessageContent(opts: FormatMessageOptions): string {
  let mes = opts.text;
  if (!mes) return '';

  mes = substituteMacros(mes, { charName: opts.charName, userName: opts.userName });
  return runMarkdownPipeline(mes);
}

/**
 * 聊天 noir：按半角括号 (...) 切旁白（弱 + 斜体）与对白（亮）。
 * 只做最外层非贪婪匹配；不配对的括号按普通正文。
 */
export function formatMessageContentNoirAssistant(opts: FormatMessageOptions): string {
  let mes = opts.text;
  if (!mes) return '';

  mes = substituteMacros(mes, { charName: opts.charName, userName: opts.userName });

  const re = /\(([\s\S]*?)\)/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(mes)) !== null) {
    if (m.index > lastIndex) {
      const chunk = mes.slice(lastIndex, m.index);
      parts.push(`<span class="mes-dialogue">${runMarkdownPipeline(chunk)}</span>`);
    }
    parts.push(`<span class="mes-narr">${runMarkdownPipeline(m[1] ?? '')}</span>`);
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex === 0 && parts.length === 0) {
    return `<span class="mes-dialogue">${runMarkdownPipeline(mes)}</span>`;
  }

  if (lastIndex < mes.length) {
    parts.push(`<span class="mes-dialogue">${runMarkdownPipeline(mes.slice(lastIndex))}</span>`);
  }

  return parts.join('');
}
