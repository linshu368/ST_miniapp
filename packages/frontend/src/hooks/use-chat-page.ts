'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCharacterQuery, useCachedLobbyCharacters } from '@/lib/api/characters';
import { useModelCatalogQuery } from '@/lib/api/models';
import { useUserSettingsQuery } from '@/lib/api/settings';
import { useTextPostprocessVersions } from '@/lib/api/text-postprocess';
import { lobbyImageUrl } from '@/components/characters/character-card';
import { resolveSessionTitle } from '@/lib/api/conversations';
import { useUserProfileStore } from '@/stores/user-profile-store';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import {
  afterNavigationQuietWindow,
  isNavigationBackgroundAllowed,
} from '@/lib/navigation-quiet-window';
import { useVisualViewportHeight } from '@/lib/use-visual-viewport-height';
import { useChatEntry, useChatDraftRecovery, useChatLikes } from './use-chat-entry';
import { useChatHistory } from './use-chat-history';
import { useConversationBranch } from './use-conversation-branch';
import { useConversationTurn } from './use-conversation-turn';
import { useChatPreferenceGuard } from './use-chat-preference-guard';
import { useChatVoice } from './use-chat-voice';
import { useThinkingNotice } from './use-thinking-notice';
import { useApiConnectionWarmth } from './use-connection-warmth';
import { useChatBack, useChatChoices } from './use-chat-page-actions';

function useChatReturnWarmup(href: string, ready: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: number | undefined;
    let idle: number | undefined;
    const cancel = () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') cancel();
    };
    const run = () => {
      if (!cancelled && canPrefetchInBackground() && isNavigationBackgroundAllowed()) {
        // Optional warming must never turn a successful chat entry into an unhandled error.
        try {
          void Promise.resolve(router.prefetch(href)).catch(() => {});
        } catch {
          /* best effort */
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void afterNavigationQuietWindow().then(() => {
      if (cancelled || !canPrefetchInBackground()) return;
      if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 1500 });
      else timer = window.setTimeout(run, 500);
    });
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [href, ready, router]);
}

export function useChatPage(characterId: string) {
  const entry = useChatEntry(characterId);
  const { session, activeSessionId, preferences } = entry;
  const history = useChatHistory(activeSessionId, session.conversationQuery.data, () =>
    turn.setStreamError('更早的消息没能加载出来')
  );
  const handoff = useChatDraftRecovery(entry, history.setEarlier);
  const branch = useConversationBranch({
    sessionId: activeSessionId,
    scope: `${entry.userScope}:${characterId}`,
    enabled: session.ready,
    onCreated: (id) => {
      handoff.clear();
      session.selectSession(id);
    },
  });
  const goBack = useChatBack(entry, branch);
  const catalog = useModelCatalogQuery({ enabled: entry.enrichReady, characterId });
  const selectedModelId = catalog.data?.selected_model_id ?? null;
  const thinkingNotice = useThinkingNotice(selectedModelId);
  const characterQuery = useCharacterQuery(characterId, {
    sessionId: activeSessionId,
    enabled: entry.enrichReady || Boolean(entry.characterPanel),
    queuePriority: 'normal',
    staleTime: 60_000,
  });
  const cachedPublic = useCachedLobbyCharacters(false)?.characters;
  // Public names/covers may decorate the shell; frozen session versions must use their own key.
  const knownSession = session.conversationQuery.data?.session;
  const canUsePublic =
    !activeSessionId || Boolean(knownSession && !knownSession.character_version_id);
  const summary = canUsePublic ? cachedPublic?.find((item) => item.id === characterId) : undefined;
  const character = characterQuery.data?.character ?? summary;
  const turn = useConversationTurn({
    characterId,
    sessionId: activeSessionId,
    selectedModelId,
    firstTokenDeadlineMs: catalog.data?.catalog.first_token_deadline_ms,
    thinkingEnabled: preferences.thinkingEnabled,
    persistedMessages: history.persisted,
    returnTo: session.returnTo,
    onSessionGone: handoff.abandonSession,
    goBack,
    onRestoreSendContent: handoff.restoreSendContent,
    onThinkingIgnored: thinkingNotice.onThinkingIgnored,
  });
  const guard = useChatPreferenceGuard(turn.runTurn);
  const settings = useUserSettingsQuery({ enabled: entry.backgroundReady });
  const voice = useChatVoice(
    activeSessionId,
    entry.backgroundReady,
    session.returnTo,
    turn.setStreamError
  );
  const likes = useChatLikes(activeSessionId, history.setEarlier);
  const choices = useChatChoices({
    sessionId: activeSessionId,
    messages: turn.messages,
    generating: turn.generating,
    creatingBranch: branch.creating,
    editingMessage: entry.editingMessage,
    serverBusy: turn.serverBusy,
    sessionReady: session.ready,
    refreshing: session.conversationQuery.isFetching,
    querySettled: session.conversationQuery.isSuccess,
    dataUpdatedAt: session.conversationQuery.dataUpdatedAt,
    guard,
  });
  const versionStates = useTextPostprocessVersions(turn.messages);
  const displayName = useUserProfileStore((state) => state.displayName);
  const viewportHeight = useVisualViewportHeight();
  useApiConnectionWarmth(entry.backgroundReady);
  useChatReturnWarmup(session.backHref, entry.backgroundReady);
  const handleSend = () => {
    if (branch.creating || !guard.canDispatch()) return;
    const content = entry.draft.trim();
    if (!content) return;
    entry.setDraft('');
    void guard.runTurn({ mode: 'send', content });
  };
  return {
    entry,
    history,
    handoff,
    branch,
    goBack,
    catalog,
    thinkingNotice,
    character,
    turn,
    guard,
    voice,
    likes,
    choices,
    versionStates,
    displayName,
    viewportHeight,
    handleSend,
    title: resolveSessionTitle(session.conversationQuery.data?.session.title, character?.name),
    characterAvatarUrl: character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null,
    userAvatarUrl: settings.data?.settings.avatar_url ?? null,
  };
}

export type ChatPageModel = ReturnType<typeof useChatPage>;
