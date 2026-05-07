import { useMemo } from 'react';
import type { Message } from '@miniapp/shared';

import { formatMessageContent } from '@/lib/markdown';

interface MessageBubbleProps {
  message: Message;
  charName?: string;
  userName?: string;
}

export function MessageBubble({ message, charName, userName }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  const renderedHtml = useMemo(() => {
    if (isUser) return '';
    return formatMessageContent({ text: message.content, charName, userName });
  }, [isUser, message.content, charName, userName]);

  // 字号 = 15px × 用户字号倍率(font-scale-store)
  const fontStyle = { fontSize: 'calc(15px * var(--mes-font-scale, 1))' };

  // 助手:全宽流式排版,像 ChatGPT/Claude 那样占满内容区
  if (!isUser) {
    return (
      <div
        style={fontStyle}
        className="mes-text animate-whisper-in w-full break-words px-1 leading-[1.5] text-foreground/90"
      >
        <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
      </div>
    );
  }

  // 用户:右侧气泡,微信式短气泡——一眼能识别"这是我说的"
  return (
    <div className="flex w-full animate-whisper-in justify-end">
      <div
        style={fontStyle}
        className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-[6px] bg-secondary/55 px-4 py-2.5 leading-[1.5] text-foreground"
      >
        {message.content}
      </div>
    </div>
  );
}
