'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetMessageLikeData } from '@miniapp/shared';
import type { CharacterDetailTab } from '@/components/characters/character-detail-sheet';
import type { MessageLikeFeedback } from '@/components/chat/chat-message-like-button';
import { useChatSession } from './use-chat-session';
import { useChatHistory } from './use-chat-history';
import { useMemoryDraft } from './use-memory-draft';
import { useChatContentPainted } from './use-chat-content-ready';
import { applyMessageLike } from '@/lib/api/conversations';
import {
  useEntryBackgroundReady,
  useEntryEnrichReady,
  markCriticalSettled,
} from '@/lib/entry-phase';
import { usePageReady } from '@/lib/perf/page-ready';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { readThinkingPreference, writeThinkingPreference } from '@/lib/chat-thinking';
import {
  DEFAULT_REPLY_DETAILS_OPEN,
  readReplyDetailsDefaultOpen,
  writeReplyDetailsDefaultOpen,
  type ReplyDetailsDefaultOpen,
} from '@/components/chat/reply-preference-display';

function useChatPreferences(userScope: string) {
  const [thinking, setThinking] = useState<{ scope: string | null; enabled: boolean }>({
    scope: null,
    enabled: true,
  });
  const [detailsDefaultOpen, setDetailsDefaultOpen] = useState<ReplyDetailsDefaultOpen>(
    DEFAULT_REPLY_DETAILS_OPEN
  );
  useEffect(() => {
    setThinking({ scope: userScope, enabled: readThinkingPreference(userScope) });
  }, [userScope]);
  useEffect(() => {
    setDetailsDefaultOpen(readReplyDetailsDefaultOpen());
  }, []);
  const changeThinkingEnabled = useCallback(
    (enabled: boolean) => {
      setThinking({ scope: userScope, enabled });
      writeThinkingPreference(userScope, enabled);
    },
    [userScope]
  );
  const handleDetailsDefaultOpenChange = useCallback((next: ReplyDetailsDefaultOpen) => {
    setDetailsDefaultOpen(next);
    writeReplyDetailsDefaultOpen(next);
  }, []);
  return {
    thinkingEnabled: thinking.scope === userScope ? thinking.enabled : true,
    changeThinkingEnabled,
    detailsDefaultOpen,
    handleDetailsDefaultOpenChange,
  };
}

export function useChatEntry(characterId: string) {
  const session = useChatSession(characterId);
  const activeSessionId = session.activeSessionId;
  const userScope = String(
    (typeof window === 'undefined' ? undefined : parseTelegramUser(getRawInitData()).id) ?? 'local'
  );
  const preferences = useChatPreferences(userScope);
  const { value: draft, setValue: setDraft } = useMemoryDraft(
    activeSessionId ? `chat:${activeSessionId}` : null
  );
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [characterPanel, setCharacterPanel] = useState<CharacterDetailTab | null>(null);
  const [characterPanelLoaded, setCharacterPanelLoaded] = useState(false);
  const [editingMessage, setEditingMessage] = useState(false);
  const painted = useChatContentPainted(activeSessionId, session.ready);
  const enrich = useEntryEnrichReady();
  const background = useEntryBackgroundReady();
  usePageReady('/chat/:id', session.ready, false, Boolean(session.entryError));
  useEffect(() => {
    if (session.ready || session.entryError) markCriticalSettled();
  }, [session.ready, session.entryError]);
  return {
    characterId,
    session,
    activeSessionId,
    userScope,
    preferences,
    draft,
    setDraft,
    sessionsOpen,
    setSessionsOpen,
    sessionsLoaded,
    setSessionsLoaded,
    characterPanel,
    setCharacterPanel,
    characterPanelLoaded,
    setCharacterPanelLoaded,
    editingMessage,
    setEditingMessage,
    enrichReady: painted && enrich,
    backgroundReady: painted && background,
  };
}

type Entry = ReturnType<typeof useChatEntry>;
type SetEarlier = ReturnType<typeof useChatHistory>['setEarlier'];

export function useChatDraftRecovery(entry: Entry, setEarlier: SetEarlier) {
  const { characterId, activeSessionId, draft, setDraft, session } = entry;
  const abandon = session.abandonSession;
  const recovery = useRef<{
    characterId: string;
    fromSessionId: string | null;
    text: string;
  } | null>(null);
  const latest = useRef({ sessionId: activeSessionId, text: draft });
  latest.current = { sessionId: activeSessionId, text: draft };
  const clear = useCallback(() => {
    recovery.current = null;
  }, []);
  const abandonSession = useCallback(() => {
    recovery.current = {
      characterId,
      fromSessionId: activeSessionId,
      text: latest.current.sessionId === activeSessionId ? latest.current.text : '',
    };
    abandon();
  }, [activeSessionId, characterId, abandon]);
  const restoreSendContent = useCallback(
    (content: string) => {
      setDraft((current) => {
        const restored = current.trim() ? current : content;
        if (
          recovery.current?.characterId === characterId &&
          recovery.current.fromSessionId === activeSessionId
        )
          recovery.current.text = restored;
        return restored;
      });
    },
    [activeSessionId, characterId, setDraft]
  );
  useEffect(() => {
    const pending = recovery.current;
    if (
      !pending ||
      !activeSessionId ||
      pending.fromSessionId === activeSessionId ||
      activeSessionId !== session.createConversation.data?.session.id
    )
      return;
    recovery.current = null;
    if (pending.characterId === characterId && pending.text)
      setDraft((current) => (current.trim() ? current : pending.text));
  }, [activeSessionId, characterId, setDraft, session.createConversation.data?.session.id]);
  useEffect(() => {
    if (!['session_not_found', 'NOT_FOUND'].includes(session.detailErrorCode ?? '')) return;
    if (activeSessionId && recovery.current?.fromSessionId !== activeSessionId)
      recovery.current = {
        characterId,
        fromSessionId: activeSessionId,
        text: latest.current.sessionId === activeSessionId ? latest.current.text : '',
      };
    setEarlier({ sessionId: activeSessionId, messages: [] });
  }, [session.detailErrorCode, activeSessionId, characterId, setEarlier]);
  return { clear, abandonSession, restoreSendContent };
}

export function useChatLikes(activeSessionId: string | null, setEarlier: SetEarlier) {
  const [likeFeedback, setLikeFeedback] = useState<MessageLikeFeedback | null>(null);
  const active = useRef(activeSessionId);
  active.current = activeSessionId;
  useEffect(() => {
    setLikeFeedback(null);
  }, [activeSessionId]);
  const handleLikeConfirmed = useCallback(
    (data: SetMessageLikeData) => {
      setEarlier((current) =>
        current.sessionId === data.session_id
          ? { ...current, messages: applyMessageLike(current.messages, data) }
          : current
      );
    },
    [setEarlier]
  );
  const handleLikeFeedback = useCallback((feedback: MessageLikeFeedback) => {
    if (active.current !== feedback.sessionId) return;
    setLikeFeedback((current) =>
      feedback.text
        ? feedback
        : current?.sessionId === feedback.sessionId && current.messageId === feedback.messageId
          ? null
          : current
    );
  }, []);
  return { likeFeedback, handleLikeConfirmed, handleLikeFeedback };
}
