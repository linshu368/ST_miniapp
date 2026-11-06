'use client';

import type { ReactNode } from 'react';
import { useChatMessageScroll } from './use-chat-message-scroll';
import { ArrowDown, Loader2 } from 'lucide-react';
import { CHAT_MESSAGE_EDIT_ROUNDS, type ChatMessage } from '@miniapp/shared';
import type { ReplyChoicePayload } from '@miniapp/reply-renderer';

import type { AssistantBodyPlan } from '@/lib/text-postprocess/reply-plan';

import { ChatMessageBubble, ChatTypingBubble } from './chat-message-bubble';
import { messageThinkingKey, type MessageThinkingMap } from '@/lib/chat-thinking';
import { ChatGuide } from '@/components/onboarding/chat-guide';

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
  renderFooter?: (message: ChatMessage, tools: ReactNode, editAction: ReactNode) => ReactNode;
  branchFor?: (message: ChatMessage) => { pending: boolean; onBranch: () => void } | undefined;
  streamingMessageId?: string | null;
  displayName?: string;
  replyPlanFor?: (message: ChatMessage) => AssistantBodyPlan;
  choiceDisabledFor?: (message: ChatMessage) => boolean;
  onChoice?: (message: ChatMessage, choice: ReplyChoicePayload) => void;
  detailsDefaultOpen?: Readonly<Record<string, boolean>>;
  thinkingByMessage?: MessageThinkingMap;
  editDisabled?: boolean;
  viewportHeight?: number | null;
  onEditingChange?: (editing: boolean) => void;
}

export function ChatMessageList(props: ChatMessageListProps) {
  const {
    messages,
    characterName,
    characterAvatarUrl,
    hasMore,
    loadingEarlier,
    onLoadEarlier,
    awaitingFirstToken,
    replyStalled,
    thinkingByMessage,
    editDisabled = false,
    onEditingChange,
  } = props;
  const latestTurn = Math.max(0, ...messages.map((message) => message.turn_index));
  const {
    editing,
    handleEditingChange,
    scrollRef,
    contentRef,
    handleScroll,
    loadEarlier,
    last,
    showLatestJump,
    hasUnseenReply,
    returnToLatest,
  } = useChatMessageScroll({
    messages,
    loadingEarlier,
    onLoadEarlier,
    awaitingFirstToken,
    thinkingByMessage,
    onEditingChange,
  });

  // 行间不留 gap：每条消息自带上下留白，行距由行内 padding 决定（对齐原版 #chat）
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-3"
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

          <MessageRows
            list={props}
            latestTurn={latestTurn}
            editing={editing}
            lastId={last?.id}
            onEditingChange={handleEditingChange}
          />

          {awaitingFirstToken ? (
            <ChatTypingBubble
              characterName={characterName}
              characterAvatarUrl={characterAvatarUrl}
              stalled={replyStalled}
            />
          ) : null}
          {messages.length > 0 ? (
            <ChatGuide
              messages={messages}
              busy={
                editing ||
                editDisabled ||
                awaitingFirstToken ||
                messages.some((message) => message.status === 'streaming')
              }
            />
          ) : null}
        </div>
      </div>
      {showLatestJump && !editing ? (
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

function MessageRows({
  list,
  latestTurn,
  editing,
  lastId,
  onEditingChange,
}: {
  list: ChatMessageListProps;
  latestTurn: number;
  editing: boolean;
  lastId?: string;
  onEditingChange: (editing: boolean) => void;
}) {
  const {
    messages,
    editDisabled,
    viewportHeight,
    characterName,
    characterAvatarUrl,
    userAvatarUrl,
    streamingMessageId,
    replyStalled,
    quotaExhaustedNotice,
    renderFooter,
    branchFor,
    replyPlanFor,
    displayName,
    choiceDisabledFor,
    onChoice,
    detailsDefaultOpen,
    thinkingByMessage,
  } = list;
  return (
    <>
      {messages
        .filter((message) => !message.deleted)
        .map((message) => (
          <ChatMessageBubble
            key={`${message.id}:${message.revision}`}
            message={message}
            editable={
              message.turn_index > 0 &&
              message.turn_index > latestTurn - CHAT_MESSAGE_EDIT_ROUNDS &&
              message.status !== 'streaming'
            }
            editDisabled={editDisabled}
            editMenuDisabled={editing}
            viewportHeight={viewportHeight}
            onEditingChange={onEditingChange}
            characterName={characterName}
            characterAvatarUrl={characterAvatarUrl}
            userAvatarUrl={userAvatarUrl}
            streaming={message.id === streamingMessageId || message.status === 'streaming'}
            stalled={replyStalled && message.id === lastId && message.status === 'streaming'}
            quotaExhaustedNotice={
              quotaExhaustedNotice?.messageId === message.id ? quotaExhaustedNotice.text : undefined
            }
            renderFooter={
              renderFooter
                ? (tools, editAction) => renderFooter(message, tools, editAction)
                : undefined
            }
            branch={branchFor?.(message)}
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
    </>
  );
}
