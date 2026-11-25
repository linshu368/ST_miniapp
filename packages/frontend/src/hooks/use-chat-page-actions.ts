'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TEXT_POSTPROCESS_LIMITS, type ChatMessage } from '@miniapp/shared';
import type { ReplyChoicePayload } from '@miniapp/reply-renderer';
import { MAX_USER_INPUT_LENGTH } from '@/components/chat/chat-composer';
import { useTelegramBackButton } from '@/lib/telegram';
import {
  emptyChoiceLock,
  markChoiceAwaitingConfirmation,
  settleChoiceLock,
  tryAdoptChoice,
  type ChoiceLockState,
} from '@/lib/text-postprocess/choice-gate';
import type { useChatEntry } from './use-chat-entry';
import type { useConversationBranch } from './use-conversation-branch';
import type { useChatPreferenceGuard } from './use-chat-preference-guard';

export function useChatBack(
  entry: ReturnType<typeof useChatEntry>,
  branch: ReturnType<typeof useConversationBranch>
) {
  const router = useRouter();
  const { characterPanel, setCharacterPanel, session } = entry;
  const { leaveView } = branch;
  const goBack = useCallback(() => {
    if (characterPanel) {
      setCharacterPanel(null);
      return;
    }
    leaveView();
    router.push(session.backHref, { scroll: false });
  }, [characterPanel, setCharacterPanel, leaveView, router, session.backHref]);
  useTelegramBackButton(goBack);
  return goBack;
}

interface ChoicesInput {
  sessionId: string | null;
  messages: ChatMessage[];
  generating: boolean;
  creatingBranch: boolean;
  editingMessage: boolean;
  serverBusy: boolean;
  sessionReady: boolean;
  refreshing: boolean;
  querySettled: boolean;
  dataUpdatedAt: number;
  guard: ReturnType<typeof useChatPreferenceGuard>;
}

export function useChatChoices(input: ChoicesInput) {
  const {
    sessionId,
    messages,
    generating,
    creatingBranch,
    editingMessage,
    serverBusy,
    sessionReady,
    refreshing,
    querySettled,
    dataUpdatedAt,
    guard,
  } = input;
  const { canDispatch, runTurn } = guard;
  const lockRef = useRef<ChoiceLockState>(emptyChoiceLock());
  const [lock, setLock] = useState<ChoiceLockState>(emptyChoiceLock());
  const gates = useMemo(
    () => ({
      generating: generating || creatingBranch || editingMessage || guard.saving,
      serverBusy,
      sessionReady,
    }),
    [generating, creatingBranch, editingMessage, guard.saving, serverBusy, sessionReady]
  );
  const commit = useCallback((next: ChoiceLockState) => {
    lockRef.current = next;
    setLock(next);
  }, []);
  useEffect(() => {
    commit(emptyChoiceLock());
  }, [sessionId, commit]);
  useEffect(() => {
    const next = settleChoiceLock(lockRef.current, {
      messages,
      refreshing: generating || refreshing,
      querySettled,
      dataUpdatedAt,
    });
    if (next !== lockRef.current) commit(next);
  }, [sessionId, commit, messages, generating, refreshing, querySettled, dataUpdatedAt, lock]);
  const handleChoice = useCallback(
    (message: ChatMessage, choice: ReplyChoicePayload) => {
      if (creatingBranch || !canDispatch()) return;
      const adopted = tryAdoptChoice(lockRef.current, {
        message,
        messages,
        text: choice.text,
        gates,
        maxLength: Math.min(MAX_USER_INPUT_LENGTH, TEXT_POSTPROCESS_LIMITS.maxOptionUnits),
        baselineUpdatedAt: dataUpdatedAt,
      });
      if (!adopted.text) return;
      // Occupy synchronously: another click in this event turn must see the lock.
      commit(adopted.state);
      void runTurn({ mode: 'send', content: adopted.text }).finally(() => {
        const next = markChoiceAwaitingConfirmation(lockRef.current);
        if (next !== lockRef.current) commit(next);
      });
    },
    [creatingBranch, canDispatch, runTurn, messages, gates, dataUpdatedAt, commit]
  );
  return { lock, gates, handleChoice };
}
