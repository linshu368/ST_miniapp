'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import type { ChatMessage } from '@miniapp/shared';
import type { ReplyChoicePayload } from '@miniapp/reply-renderer';

import type { AssistantBodyPlan } from '@/lib/text-postprocess/reply-plan';

import { cn } from '@/lib/utils';
import { PH_CHAT_REPLAY_VISIBLE_CLASS } from '@/lib/telemetry/masking';
import { ChatMessageBubble, ChatTypingBubble } from './chat-message-bubble';
import { messageThinkingKey, type MessageThinkingMap } from '@/lib/chat-thinking';

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
  /** 刚好用完免费额度的那一轮回复下方展示轻提示 */
  quotaExhaustedNotice?: { messageId: string; text: string };
  /** 挂在指定消息下方的操作区 */
  renderFooter?: (message: ChatMessage) => ReactNode;
  streamingMessageId?: string | null;
  displayName?: string;
  replyPlanFor?: (message: ChatMessage) => AssistantBodyPlan;
  choiceDisabledFor?: (message: ChatMessage) => boolean;
  onChoice?: (message: ChatMessage, choice: ReplyChoicePayload) => void;
  detailsDefaultOpen?: Readonly<Record<string, boolean>>;
  thinkingByMessage?: MessageThinkingMap;
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
  quotaExhaustedNotice,
  renderFooter,
  streamingMessageId,
  displayName,
  replyPlanFor,
  choiceDisabledFor,
  onChoice,
  detailsDefaultOpen,
  thinkingByMessage,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const earlierAnchorRef = useRef<{ firstId: string; height: number; top: number } | null>(null);
  const [showLatestJump, setShowLatestJump] = useState(false);
  const [hasUnseenReply, setHasUnseenReply] = useState(false);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (earlierAnchorRef.current) earlierAnchorRef.current.top = node.scrollTop;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distanceToBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = atBottom;
    setShowLatestJump(!atBottom);
    if (atBottom) setHasUnseenReply(false);
  }, []);

  const loadEarlier = () => {
    const node = scrollRef.current;
    const first = messages[0];
    if (!node || !first || loadingEarlier) return;
    earlierAnchorRef.current = {
      firstId: first.id,
      height: node.scrollHeight,
      top: node.scrollTop,
    };
    stickToBottomRef.current = false;
    onLoadEarlier();
  };

  // 前插历史后保留原来读到的那句话；不能因消息变长而跳到底部或跳到页首。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const anchor = earlierAnchorRef.current;
    if (!node || !anchor) return;
    if (messages[0]?.id !== anchor.firstId) {
      node.scrollTop = anchor.top + node.scrollHeight - anchor.height;
      earlierAnchorRef.current = null;
      handleScroll();
    } else if (!loadingEarlier) {
      earlierAnchorRef.current = null;
    }
  }, [messages, loadingEarlier, handleScroll]);

  const last = messages.at(-1);
  const thinkingLength = last ? (thinkingByMessage?.[messageThinkingKey(last)]?.length ?? 0) : 0;
  // 流式期间正文长度每帧都在变，把它放进依赖里才能跟着往下滚
  const tail = `${last?.id ?? ''}:${last?.content.length ?? 0}:${thinkingLength}:${awaitingFirstToken}`;
  const assistantUpdate =
    last?.role === 'assistant'
      ? `${last.id}:${last.revision}:${last.content.length}:${thinkingLength}:${last.status}`
      : null;
  const previousAssistantUpdate = useRef(assistantUpdate);

  useEffect(() => {
    const replyChanged =
      assistantUpdate !== null && assistantUpdate !== previousAssistantUpdate.current;
    previousAssistantUpdate.current = assistantUpdate;
    if (!stickToBottomRef.current) {
      if (replyChanged) setHasUnseenReply(true);
      return;
    }
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [tail, assistantUpdate]);

  const returnToLatest = () => {
    const node = scrollRef.current;
    if (!node) return;
    earlierAnchorRef.current = null;
    stickToBottomRef.current = true;
    setShowLatestJump(false);
    setHasUnseenReply(false);
    node.scrollTo({ top: node.scrollHeight, behavior: 'auto' });
  };

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
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, []);

  // 行间不留 gap：每条消息自带上下留白，行距由行内 padding 决定（对齐原版 #chat）
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn(
          'chat-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-3',
          PH_CHAT_REPLAY_VISIBLE_CLASS
        )}
      >
        <div ref={contentRef}>
          {hasMore ? (
            <div className="flex justify-center pb-2 pt-1">
              <button
                type="button"
                onClick={loadEarlier}
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
              quotaExhaustedNotice={
                quotaExhaustedNotice?.messageId === message.id
                  ? quotaExhaustedNotice.text
                  : undefined
              }
              footer={renderFooter?.(message)}
              replyPlan={message.role === 'assistant' ? replyPlanFor?.(message) : undefined}
              displayName={displayName}
              choiceDisabled={choiceDisabledFor?.(message) !== false}
              onChoice={
                onChoice && message.role === 'assistant'
                  ? (choice) => onChoice(message, choice)
                  : undefined
              }
              detailsDefaultOpen={detailsDefaultOpen}
              thinkingText={thinkingByMessage?.[messageThinkingKey(message)]}
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
      </div>
      {showLatestJump ? (
        <button
          type="button"
          onClick={returnToLatest}
          className="absolute bottom-3 right-3 z-10 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-primary/30 bg-card/95 px-4 text-xs font-medium text-primary shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          {hasUnseenReply ? '有新回复 · 回到最新' : '回到最新'}
        </button>
      ) : null}
    </div>
  );
}
