'use client';

import { memo, useMemo } from 'react';
import DOMPurify, { type Config as SanitizeConfig } from 'dompurify';
import { Converter } from 'showdown';

// 模型输出里最常见的就是这四类：强调、列表、引用体旁白、分段。
// 表格与图片刻意不开——角色扮演场景用不到，开着只是扩大 XSS 面。
const converter = new Converter({
  simpleLineBreaks: true,
  strikethrough: true,
  literalMidWordUnderscores: true,
  tables: false,
  ghCodeBlocks: true,
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
  // 一个属性都不放。角色扮演的正文里没有需要属性的场景，允许列表越短越好审
  ALLOWED_ATTR: [],
};

/**
 * 渲染模型输出。
 *
 * memo 的比较键是 `content`：流式期间父组件每帧重渲染，但只有正在生成的那条内容在变，
 * 历史消息不该跟着重新 makeHtml + sanitize。
 */
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  const html = useMemo(() => {
    // dompurify 需要真实 DOM。本组件只在客户端拿到会话数据后才有内容可渲染，
    // 真跑到服务端说明前提变了——那就什么都不输出，绝不放未净化的 HTML 过去。
    if (typeof window === 'undefined') return '';
    return DOMPurify.sanitize(converter.makeHtml(content), SANITIZE_OPTIONS);
  }, [content]);

  return (
    <div
      className="chat-markdown text-[15px] leading-[1.75] [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_em]:text-muted-foreground [&_h3]:mt-3 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
