'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { ChatMessage } from '@miniapp/shared';

import { ChatMessageBubble, ChatTypingBubble } from './chat-message-bubble';

/** 距底部多少像素内算「用户还在看最新消息」，超出就认为他在翻历史 */
const STICK_TO_BOTTOM_THRESHOLD_PX = 120;

interface ChatMessageListProps {
  /** 已按 turn_index 升序，包含正在流式写入的那条 */
  messages: ChatMessage[];
  characterName: string;
  characterAvatarUrl: string | null;
  userAvatarUrl: string | null;
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** 请求已发出但 start 事件还没到，先给个呼吸点 */
  awaitingFirstToken: boolean;
  /** 当前回复一段时间没有新内容 */
  replyStalled?: boolean;
  /** 挂在指定消息下方的操作区 */
  renderFooter?: (message: ChatMessage) => ReactNode;
  streamingMessageId?: string | null;
}

export function ChatMessageList({
  messages,
  characterName,
  characterAvatarUrl,
  userAvatarUrl,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  awaitingFirstToken,
  replyStalled,
  renderFooter,
  streamingMessageId,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distanceToBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
  }, []);

  const last = messages.at(-1);
  // 流式期间正文长度每帧都在变，把它放进依赖里才能跟着往下滚
  const tail = `${last?.id ?? ''}:${last?.content.length ?? 0}:${awaitingFirstToken}`;

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [tail]);

  /**
   * 键盘弹起会让消息区变矮，浏览器保留 scrollTop，最新那条就被推到折线以下。
   * 只在用户本来就贴着底部时补一次，正在翻历史的人不该被拽回去。
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 行间不留 gap：每条消息自带上下留白，行距由行内 padding 决定（对齐原版 #chat）
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="chat-scroll-area flex-1 overflow-y-auto overscroll-contain pb-2 pt-3"
    >
      {hasMore ? (
        <div className="flex justify-center pb-2 pt-1">
          <button
            type="button"
            onClick={onLoadEarlier}
            disabled={loadingEarlier}
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
          >
            {loadingEarlier ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            {loadingEarlier ? '加载中' : '查看更早的消息'}
          </button>
        </div>
      ) : null}

      {messages.map((message) => (
        <ChatMessageBubble
          key={`${message.id}:${message.revision}`}
          message={message}
          characterName={characterName}
          characterAvatarUrl={characterAvatarUrl}
          userAvatarUrl={userAvatarUrl}
          streaming={message.id === streamingMessageId || message.status === 'streaming'}
          stalled={replyStalled && message.id === last?.id && message.status === 'streaming'}
          footer={renderFooter?.(message)}
        />
      ))}

      {awaitingFirstToken ? (
        <ChatTypingBubble
          characterName={characterName}
          characterAvatarUrl={characterAvatarUrl}
          stalled={replyStalled}
        />
      ) : null}
    </div>
  );
}
