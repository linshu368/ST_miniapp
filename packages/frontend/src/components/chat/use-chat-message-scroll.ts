'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type MutableRefObject,
  type TouchEvent,
  type WheelEvent,
} from 'react';
import type { ChatMessage } from '@miniapp/shared';
import { messageThinkingKey, type MessageThinkingMap } from '@/lib/chat-thinking';
import { useReplySizeStore } from '@/stores/reply-size-store';

const STICK_TO_BOTTOM_THRESHOLD_PX = 120;
const EARLIER_PAGE_EDGE_PX = 24;
const EARLIER_SWIPE_PX = 24;
const SCROLL_INTENT_MS = 1_000;

export function useChatMessageScroll({
  messages,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  awaitingFirstToken,
  thinkingByMessage,
  onEditingChange,
}: {
  messages: ChatMessage[];
  hasMore: boolean;
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
  const [showLatestJump, setShowLatestJump] = useState(false);
  const [hasUnseenReply, setHasUnseenReply] = useState(false);

  const syncScrollPosition = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distanceToBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = atBottom && !editingRef.current;
    setShowLatestJump(!atBottom);
    if (atBottom) setHasUnseenReply(false);
  }, []);

  const earlierPage = useEarlierPageScroll({
    scrollRef,
    stickToBottomRef,
    firstId: messages[0]?.id,
    hasMore,
    loadingEarlier,
    onLoadEarlier,
    syncScrollPosition,
  });

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
    earlierPage.clearAnchor();
    stickToBottomRef.current = true;
    setShowLatestJump(false);
    setHasUnseenReply(false);
    node.scrollTo({ top: node.scrollHeight, behavior: 'auto' });
  };

  useStickToBottomResize(scrollRef, contentRef, stickToBottomRef);
  useKeepReadingPlace(scrollRef, contentRef, stickToBottomRef);
  return {
    editing,
    handleEditingChange,
    scrollRef,
    contentRef,
    ...earlierPage,
    last,
    showLatestJump,
    hasUnseenReply,
    returnToLatest,
  };
}

function useEarlierPageScroll({
  scrollRef,
  stickToBottomRef,
  firstId,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  syncScrollPosition,
}: {
  scrollRef: RefObject<HTMLDivElement>;
  stickToBottomRef: MutableRefObject<boolean>;
  firstId: string | undefined;
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  syncScrollPosition: () => void;
}) {
  const anchor = useRef<{ firstId: string; height: number; top: number } | null>(null);
  const intentUntil = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastWheelAt = useRef(-Infinity);

  const loadEarlier = () => {
    const node = scrollRef.current;
    if (!node || !firstId || !hasMore || loadingEarlier || anchor.current) return;
    anchor.current = { firstId, height: node.scrollHeight, top: node.scrollTop };
    intentUntil.current = 0;
    touchStart.current = null;
    stickToBottomRef.current = false;
    onLoadEarlier();
  };

  const loadNearTop = () => {
    const node = scrollRef.current;
    if (node && node.scrollTop <= EARLIER_PAGE_EDGE_PX && performance.now() < intentUntil.current)
      loadEarlier();
  };

  const handleScroll = () => {
    const node = scrollRef.current;
    if (node && anchor.current) anchor.current.top = node.scrollTop;
    syncScrollPosition();
    loadNearTop();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const now = performance.now();
    if (event.deltaY < 0) {
      if (now - lastWheelAt.current > 200) intentUntil.current = now + SCROLL_INTENT_MS;
      else if (now < intentUntil.current) intentUntil.current = now + SCROLL_INTENT_MS;
      loadNearTop();
    } else {
      intentUntil.current = 0;
    }
    lastWheelAt.current = now;
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    touchStart.current = point ? { x: point.clientX, y: point.clientY } : null;
    intentUntil.current = 0;
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStart.current;
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    if (!start || !point) return;
    const dy = point.clientY - start.y;
    // The gesture also works when a short first page has no scrollable overflow.
    intentUntil.current =
      dy >= EARLIER_SWIPE_PX && dy > Math.abs(point.clientX - start.x)
        ? performance.now() + SCROLL_INTENT_MS
        : 0;
    loadNearTop();
  };

  // Preserve the reading position after prepend without treating the adjustment as intent.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const previous = anchor.current;
    if (!node || !previous) return;
    if (firstId !== previous.firstId) {
      node.scrollTop = previous.top + node.scrollHeight - previous.height;
      anchor.current = null;
      syncScrollPosition();
    } else if (!loadingEarlier) {
      anchor.current = null;
    }
  }, [firstId, loadingEarlier, scrollRef, syncScrollPosition]);

  return {
    clearAnchor: () => {
      anchor.current = null;
      intentUntil.current = 0;
      touchStart.current = null;
    },
    loadEarlier,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
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

/**
 * 改字号时正在读的那一段留在原位。
 * 订阅在状态改变的瞬间触发，这时页面还是旧字号，先记下位置；新字号排好后再补回差值。
 * 本来贴着底部的不用管，上面的 ResizeObserver 会继续贴底。
 */
function useKeepReadingPlace(
  scrollRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
  stickToBottomRef: MutableRefObject<boolean>
) {
  const level = useReplySizeStore((state) => state.level);
  const anchorRef = useRef<{ node: Element; top: number } | null>(null);
  useEffect(
    () =>
      useReplySizeStore.subscribe((state, previous) => {
        if (state.level === previous.level) return;
        const viewport = scrollRef.current;
        const content = contentRef.current;
        if (!viewport || !content || stickToBottomRef.current) {
          anchorRef.current = null;
          return;
        }
        const top = viewport.getBoundingClientRect().top;
        const node = [
          ...content.querySelectorAll('.chat-markdown p, .chat-markdown li, [data-user-text]'),
        ].find((element) => element.getBoundingClientRect().bottom > top + 8);
        anchorRef.current = node ? { node, top: node.getBoundingClientRect().top } : null;
      }),
    [contentRef, scrollRef, stickToBottomRef]
  );
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const viewport = scrollRef.current;
    anchorRef.current = null;
    if (!anchor || !viewport || !anchor.node.isConnected) return;
    viewport.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top;
  }, [level, scrollRef]);
}
