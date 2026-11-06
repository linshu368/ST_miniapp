'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type MutableRefObject,
} from 'react';
import type { ChatMessage } from '@miniapp/shared';
import { messageThinkingKey, type MessageThinkingMap } from '@/lib/chat-thinking';

const STICK_TO_BOTTOM_THRESHOLD_PX = 120;

export function useChatMessageScroll({
  messages,
  loadingEarlier,
  onLoadEarlier,
  awaitingFirstToken,
  thinkingByMessage,
  onEditingChange,
}: {
  messages: ChatMessage[];
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  awaitingFirstToken: boolean;
  thinkingByMessage?: MessageThinkingMap;
  onEditingChange?: (editing: boolean) => void;
}) {
  const editingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const handleEditingChange = useCallback(
    (editing: boolean) => {
      editingRef.current = editing;
      setEditing(editing);
      if (editing) stickToBottomRef.current = false;
      onEditingChange?.(editing);
    },
    [onEditingChange]
  );
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
    stickToBottomRef.current = atBottom && !editingRef.current;
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

  useStickToBottomResize(scrollRef, contentRef, stickToBottomRef);
  return {
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
  };
}

function useStickToBottomResize(
  scrollRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
  stickToBottomRef: MutableRefObject<boolean>
) {
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
  }, [contentRef, scrollRef, stickToBottomRef]);
}
