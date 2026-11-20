'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, GetConversationData } from '@miniapp/shared';
import { fetchConversationPage } from '@/lib/api/conversations';

const EMPTY_MESSAGES: ChatMessage[] = [];

/** Newer snapshots replace a whole turn, including the old regeneration revision. */
export function mergeChatHistory(...pages: ChatMessage[][]): ChatMessage[] {
  const turns = new Map<number, ChatMessage[]>();
  for (const page of pages) {
    const grouped = new Map<number, ChatMessage[]>();
    for (const message of page) {
      const rows = grouped.get(message.turn_index) ?? [];
      rows.push(message);
      grouped.set(message.turn_index, rows);
    }
    for (const [turn, rows] of grouped) {
      const revision = Math.max(...rows.map((message) => message.revision));
      const previousRevision = turns.get(turn)?.[0]?.revision ?? -1;
      if (revision >= previousRevision)
        turns.set(turn, [
          ...new Map(
            rows
              .filter((message) => message.revision === revision)
              .map((message) => [message.id, message])
          ).values(),
        ]);
    }
  }
  return [...turns]
    .sort(([a], [b]) => a - b)
    .flatMap(([, messages]) =>
      messages.sort((a, b) => (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1))
    );
}

/** Fill a gap left by another device's newer turns before moving past the oldest loaded turn. */
export function historyPageCursor(messages: ChatMessage[]): number | undefined {
  const turns = [...new Set(messages.map((message) => message.turn_index))].sort((a, b) => a - b);
  for (let i = turns.length - 1; i > 0; i--) {
    const newer = turns[i];
    const older = turns[i - 1];
    if (newer !== undefined && older !== undefined && newer > older + 1) return newer;
  }
  return turns[0];
}

export function useChatHistory(
  sessionId: string | null,
  data: GetConversationData | undefined,
  onError: () => void
) {
  const [earlier, setEarlier] = useState<{ sessionId: string | null; messages: ChatMessage[] }>({
    sessionId: null,
    messages: [],
  });
  const previous = useRef<{ sessionId: string | null; messages: ChatMessage[] }>({
    sessionId: null,
    messages: [],
  });
  const request = useRef<AbortController | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [more, setMore] = useState<{ sessionId: string | null; value: boolean } | null>(null);
  const head = data?.session.id === sessionId ? data.messages : EMPTY_MESSAGES;
  const persisted = useMemo(
    () =>
      mergeChatHistory(
        earlier.sessionId === sessionId ? earlier.messages : [],
        previous.current.sessionId === sessionId ? previous.current.messages : [],
        head
      ),
    [earlier, sessionId, head]
  );
  useEffect(() => {
    if (previous.current.sessionId === sessionId && previous.current.messages !== head) {
      const oldHead = previous.current.messages;
      setEarlier((current) => ({
        sessionId,
        messages: mergeChatHistory(
          current.sessionId === sessionId ? current.messages : [],
          oldHead
        ),
      }));
    }
    previous.current = { sessionId, messages: head };
  }, [sessionId, head]);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setLoadingEarlier(false);
    setMore(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [sessionId]);
  const cursor = historyPageCursor(persisted);
  const gap = cursor !== undefined && cursor !== persisted[0]?.turn_index;
  const hasMoreEarlier =
    gap || (more?.sessionId === sessionId ? more.value : (data?.has_more ?? false));
  const handleLoadEarlier = async () => {
    if (!sessionId || cursor === undefined || request.current) return;
    const identity = new AbortController();
    request.current = identity;
    setLoadingEarlier(true);
    try {
      const page = await fetchConversationPage(sessionId, cursor, identity.signal);
      if (request.current !== identity) return;
      if (
        page.session.id !== sessionId ||
        page.messages.some((message) => message.session_id !== sessionId)
      )
        throw new Error('Invalid conversation page identity');
      setEarlier((current) => ({
        sessionId,
        messages: mergeChatHistory(
          page.messages,
          current.sessionId === sessionId ? current.messages : []
        ),
      }));
      // A gap page only updates the oldest-page boundary if it reaches that boundary too.
      const oldest = persisted[0]?.turn_index;
      const reachedOldest = page.messages.some(
        (message) => oldest !== undefined && message.turn_index <= oldest
      );
      if (!gap || reachedOldest) setMore({ sessionId, value: page.has_more });
    } catch {
      if (request.current === identity) onError();
    } finally {
      if (request.current === identity) {
        request.current = null;
        setLoadingEarlier(false);
      }
    }
  };
  return { persisted, setEarlier, loadingEarlier, hasMoreEarlier, handleLoadEarlier };
}
