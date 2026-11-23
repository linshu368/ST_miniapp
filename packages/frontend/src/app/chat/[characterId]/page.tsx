'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, X } from 'lucide-react';
import {
  FIRST_TOKEN_RETRY_MESSAGE,
  TEXT_POSTPROCESS_LIMITS,
  type ChatMessage,
  type SetMessageLikeData,
} from '@miniapp/shared';
import type { ReplyChoicePayload } from '@miniapp/reply-renderer';

import {
  CONVERSATION_RECOVERING_MESSAGE,
  CONVERSATION_SLOW_NETWORK_MESSAGE,
} from '@/lib/api/conversation-stream';
import { ChatComposer, MAX_USER_INPUT_LENGTH } from '@/components/chat/chat-composer';
import { ChatMessageList } from '@/components/chat/chat-message-list';
import {
  ChatMessageLikeButton,
  type MessageLikeFeedback,
} from '@/components/chat/chat-message-like-button';
import {
  canBranchFromMessage,
  canLikeMessage,
  getChatReplyPresentation,
} from '@/components/chat/chat-reply-presentation';
import { ChatRegenerateButton } from '@/components/chat/chat-regenerate-button';
import { ChatToolsSheet } from '@/components/chat/chat-tools-sheet';
import { DramaSurveyPrompt } from '@/components/chat/drama-survey-prompt';
import { ChatTopBar } from '@/components/chat/chat-top-bar';
import { lobbyImageUrl } from '@/components/characters/character-card';
import type { CharacterDetailTab } from '@/components/characters/character-detail-sheet';
import { ChatSplash } from '@/components/chat/chat-splash';
import { useChatSession } from '@/hooks/use-chat-session';
import { useChatHistory } from '@/hooks/use-chat-history';
import { useChatVoice } from '@/hooks/use-chat-voice';
import { CHAT_PREFERENCES_SAVING, useChatPreferenceGuard } from '@/hooks/use-chat-preference-guard';
import { useMemoryDraft } from '@/hooks/use-memory-draft';
import { useApiConnectionWarmth } from '@/hooks/use-connection-warmth';
import { useConversationTurn } from '@/hooks/use-conversation-turn';
import { useConversationBranch } from '@/hooks/use-conversation-branch';
import { useCharacterQuery } from '@/lib/api/characters';
import { useTextPostprocessVersions } from '@/lib/api/text-postprocess';
import { applyMessageLike, resolveSessionTitle } from '@/lib/api/conversations';
import { useModelCatalogQuery } from '@/lib/api/models';
import { useCharacterFreeQuotaQuery } from '@/lib/api/free-quota';
import { useUserSettingsQuery } from '@/lib/api/settings';
import { customVoicePath } from '@/lib/chat-entry';
import {
  choiceButtonsDisabled,
  emptyChoiceLock,
  markChoiceAwaitingConfirmation,
  settleChoiceLock,
  tryAdoptChoice,
  type ChoiceLockState,
} from '@/lib/text-postprocess/choice-gate';
import { planMessageReply } from '@/lib/text-postprocess/reply-plan';
import { useUserProfileStore } from '@/stores/user-profile-store';
import { redirectToRecharge } from '@/lib/recharge-redirect';
import { useTelegramBackButton } from '@/lib/telegram';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { readThinkingPreference, writeThinkingPreference } from '@/lib/chat-thinking';
import { useThinkingNotice } from '@/hooks/use-thinking-notice';
import { useVisualViewportHeight } from '@/lib/use-visual-viewport-height';
import {
  markCriticalSettled,
  useEntryBackgroundReady,
  useEntryEnrichReady,
} from '@/lib/entry-phase';
import { usePageReady } from '@/lib/perf/page-ready';
import {
  DEFAULT_REPLY_DETAILS_OPEN,
  readReplyDetailsDefaultOpen,
  writeReplyDetailsDefaultOpen,
  type ReplyDetailsDefaultOpen,
} from '@/components/chat/reply-preference-display';

const CharacterDetailSheet = dynamic(
  () =>
    import('@/components/characters/character-detail-sheet').then((module) => ({
      default: module.CharacterDetailSheet,
    })),
  { ssr: false }
);

// 状态面板不进首屏关键路径：组件和数据都在页面就绪后再加载。
const ChatStatusPanel = dynamic(
  () =>
    import('@/components/status-bar/chat-status-panel').then((module) => module.ChatStatusPanel),
  { ssr: false }
);
const ChatSessionDrawer = dynamic(
  () =>
    import('@/components/chat/chat-session-drawer').then((module) => ({
      default: module.ChatSessionDrawer,
    })),
  { ssr: false }
);

const ChatMessageVoiceFooter = dynamic(
  () =>
    import('@/components/chat/chat-message-voice').then((module) => ({
      default: module.ChatMessageVoiceFooter,
    })),
  {
    ssr: false,
    loading: () => (
      <span
        role="status"
        className="inline-flex min-h-11 items-center text-[11px] text-muted-foreground"
      >
        回复工具加载中
      </span>
    ),
  }
);

function isSoftStreamNotice(message: string): boolean {
  return (
    message === FIRST_TOKEN_RETRY_MESSAGE ||
    message === CONVERSATION_RECOVERING_MESSAGE ||
    message === CONVERSATION_SLOW_NETWORK_MESSAGE
  );
}

export default function SelfHostedChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const router = useRouter();

  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [characterPanel, setCharacterPanel] = useState<CharacterDetailTab | null>(null);
  const [likeFeedback, setLikeFeedback] = useState<MessageLikeFeedback | null>(null);
  const [characterPanelLoaded, setCharacterPanelLoaded] = useState(false);
  const choiceLockRef = useRef<ChoiceLockState>(emptyChoiceLock());
  const [choiceLock, setChoiceLock] = useState<ChoiceLockState>(emptyChoiceLock());
  const [detailsDefaultOpen, setDetailsDefaultOpen] = useState<ReplyDetailsDefaultOpen>(
    DEFAULT_REPLY_DETAILS_OPEN
  );
  const displayName = useUserProfileStore((state) => state.displayName);
  const userScope = String(
    (typeof window === 'undefined' ? undefined : parseTelegramUser(getRawInitData()).id) ?? 'local'
  );
  const [thinkingPreference, setThinkingPreference] = useState<{
    scope: string | null;
    enabled: boolean;
  }>({ scope: null, enabled: true });
  const thinkingEnabled =
    thinkingPreference.scope === userScope ? thinkingPreference.enabled : true;

  useEffect(() => {
    setThinkingPreference({ scope: userScope, enabled: readThinkingPreference(userScope) });
  }, [userScope]);

  const changeThinkingEnabled = useCallback(
    (enabled: boolean) => {
      setThinkingPreference({ scope: userScope, enabled });
      writeThinkingPreference(userScope, enabled);
    },
    [userScope]
  );

  const session = useChatSession(characterId);
  const { activeSessionId, returnTo, abandonSession } = session;
  const enrichReady = useEntryEnrichReady();
  const backgroundReady = useEntryBackgroundReady();
  const { value: draft, setValue: setDraft } = useMemoryDraft(
    activeSessionId ? `chat:${activeSessionId}` : null
  );
  // 可用 = 会话已建立且历史消息已加载（新会话的创建耗时也算在用户等待里）。
  usePageReady('/chat/:id', session.ready, false, Boolean(session.entryError));
  // 会话就绪或创建/加载失败都结算 P0，放行模型目录等 enrich。
  useEffect(() => {
    if (session.ready || session.entryError) markCriticalSettled();
  }, [session.ready, session.entryError]);
  const modelCatalogQuery = useModelCatalogQuery({ enabled: enrichReady, characterId });
  const selectedModelId = modelCatalogQuery.data?.selected_model_id ?? null;
  const thinkingNotice = useThinkingNotice(selectedModelId);
  const selectedModelUsesFreeQuota = useMemo(() => {
    const catalog = modelCatalogQuery.data?.catalog;
    if (!catalog || !selectedModelId) return null;
    return (
      catalog.tiers.flatMap((tier) => tier.models).find((model) => model.id === selectedModelId)
        ?.is_free ?? null
    );
  }, [modelCatalogQuery.data?.catalog, selectedModelId]);

  const { persisted, setEarlier, loadingEarlier, hasMoreEarlier, handleLoadEarlier } =
    useChatHistory(activeSessionId, session.conversationQuery.data, () =>
      setStreamError('更早的消息没能加载出来')
    );

  const draftRecoveryRef = useRef<{
    characterId: string;
    fromSessionId: string | null;
    text: string;
  } | null>(null);
  const branch = useConversationBranch({
    sessionId: activeSessionId,
    scope: `${userScope}:${characterId}`,
    enabled: session.ready,
    onCreated: (nextSessionId) => {
      draftRecoveryRef.current = null;
      session.selectSession(nextSessionId);
    },
  });
  const { leaveView: leaveBranchView } = branch;
  const latestDraftRef = useRef({ sessionId: activeSessionId, text: draft });
  latestDraftRef.current = { sessionId: activeSessionId, text: draft };
  const handleLikeConfirmed = useCallback(
    (data: SetMessageLikeData) => {
      // 旧页不在详情 query 内；只同步这一次点赞对应的会话与固定消息版本。
      setEarlier((current) =>
        current.sessionId === data.session_id
          ? { ...current, messages: applyMessageLike(current.messages, data) }
          : current
      );
    },
    [setEarlier]
  );
  const handleLikeFeedback = useCallback(
    (feedback: MessageLikeFeedback) => {
      if (latestDraftRef.current.sessionId !== feedback.sessionId) return;
      setLikeFeedback((current) =>
        feedback.text
          ? feedback
          : current?.sessionId === feedback.sessionId && current.messageId === feedback.messageId
            ? null
            : current
      );
    },
    [setEarlier]
  );
  const abandonSessionWithDraft = useCallback(() => {
    const current = latestDraftRef.current;
    draftRecoveryRef.current = {
      characterId,
      fromSessionId: activeSessionId,
      text: current.sessionId === activeSessionId ? current.text : '',
    };
    abandonSession();
  }, [activeSessionId, characterId, abandonSession]);

  useEffect(() => {
    const recovery = draftRecoveryRef.current;
    if (
      !recovery ||
      !activeSessionId ||
      recovery.fromSessionId === activeSessionId ||
      activeSessionId !== session.createConversation.data?.session.id
    )
      return;
    draftRecoveryRef.current = null;
    if (recovery.characterId === characterId && recovery.text) {
      setDraft((current) => (current.trim() ? current : recovery.text));
    }
  }, [activeSessionId, characterId, setDraft, session.createConversation.data?.session.id]);

  const goBack = useCallback(() => {
    if (characterPanel) {
      setCharacterPanel(null);
      return;
    }
    leaveBranchView();
    router.push(session.backHref, { scroll: false });
  }, [router, session.backHref, characterPanel, leaveBranchView]);
  useTelegramBackButton(goBack);

  useEffect(() => {
    router.prefetch('/characters');
  }, [router]);

  const restoreSendContent = useCallback(
    (content: string) => {
      setDraft((current) => {
        const recovered = current.trim() ? current : content;
        const handoff = draftRecoveryRef.current;
        if (handoff?.characterId === characterId && handoff.fromSessionId === activeSessionId) {
          handoff.text = recovered;
        }
        return recovered;
      });
    },
    [activeSessionId, characterId, setDraft]
  );

  const [editingMessage, setEditingMessage] = useState(false);
  const characterQuery = useCharacterQuery(characterId, { sessionId: activeSessionId });
  const character = characterQuery.data?.character;

  useApiConnectionWarmth();

  const {
    abort,
    canRegenerate,
    cancelling,
    generating,
    lastMessage,
    messages,
    quotaExhaustedNotice,
    freeZoneSwitchNotice,
    replyStalled,
    runTurn: dispatchTurn,
    serverBusy,
    setStreamError,
    streamError,
    streaming,
    thinkingByMessage,
  } = useConversationTurn({
    characterId,
    firstTokenDeadlineMs: modelCatalogQuery.data?.catalog.first_token_deadline_ms,
    characterName: character?.name,
    sessionId: activeSessionId,
    selectedModelId,
    selectedModelUsesFreeQuota,
    thinkingEnabled,
    persistedMessages: persisted,
    returnTo,
    onSessionGone: abandonSessionWithDraft,
    goBack,
    onRestoreSendContent: restoreSendContent,
    onThinkingIgnored: thinkingNotice.onThinkingIgnored,
  });

  const { saving: preferencesSaving, canDispatch, runTurn } = useChatPreferenceGuard(dispatchTurn);
  const userSettingsQuery = useUserSettingsQuery({ enabled: backgroundReady });
  const voice = useChatVoice(activeSessionId, backgroundReady, returnTo, setStreamError);
  const viewportHeight = useVisualViewportHeight();

  const characterAvatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;
  const userAvatarUrl = userSettingsQuery.data?.settings.avatar_url ?? null;

  useEffect(() => {
    setLikeFeedback(null);
  }, [activeSessionId]);

  useEffect(() => {
    setDetailsDefaultOpen(readReplyDetailsDefaultOpen());
  }, []);

  const handleDetailsDefaultOpenChange = useCallback((next: ReplyDetailsDefaultOpen) => {
    setDetailsDefaultOpen(next);
    writeReplyDetailsDefaultOpen(next);
  }, []);

  useEffect(() => {
    if (
      session.detailErrorCode !== 'session_not_found' &&
      session.detailErrorCode !== 'NOT_FOUND'
    ) {
      return;
    }
    // 查询发现旧会话已失效时，useChatSession 会重建；仅沿这条明确的恢复路径交接草稿。
    if (activeSessionId && draftRecoveryRef.current?.fromSessionId !== activeSessionId) {
      draftRecoveryRef.current = {
        characterId,
        fromSessionId: activeSessionId,
        text:
          latestDraftRef.current.sessionId === activeSessionId ? latestDraftRef.current.text : '',
      };
    }
    setEarlier({ sessionId: activeSessionId, messages: [] });
  }, [session.detailErrorCode, activeSessionId, characterId, setEarlier]);

  const playbackRate = voice.config?.config.playback_rate ?? 1;
  const freeQuota = useCharacterFreeQuotaQuery(characterId, { enabled: enrichReady });
  const freeRoundActive = Boolean(
    freeQuota.data && !freeQuota.data.exhausted && selectedModelUsesFreeQuota
  );

  /**
   * 哪些消息能生成语音。turn_index > 0 排掉开场白，status 排掉正在写和没写完的——
   * 后端认的 messageId 是 chat_history 行 id，这两类要么不是库里的行，要么没有正文。
   */
  const canGenerateVoice = useCallback(
    (message: ChatMessage): boolean =>
      !message.inherited &&
      getChatReplyPresentation(message) === 'complete' &&
      message.turn_index > 0,
    []
  );

  const versionStates = useTextPostprocessVersions(messages);
  const choiceLimit = Math.min(MAX_USER_INPUT_LENGTH, TEXT_POSTPROCESS_LIMITS.maxOptionUnits);
  const choiceGates = useMemo(
    () => ({
      generating: generating || branch.creating || editingMessage || preferencesSaving,
      serverBusy,
      sessionReady: session.ready,
    }),
    [generating, branch.creating, editingMessage, preferencesSaving, serverBusy, session.ready]
  );

  const commitChoiceLock = useCallback((next: ChoiceLockState) => {
    choiceLockRef.current = next;
    setChoiceLock(next);
  }, []);

  useEffect(() => {
    commitChoiceLock(emptyChoiceLock());
  }, [activeSessionId, commitChoiceLock]);

  useEffect(() => {
    const next = settleChoiceLock(choiceLockRef.current, {
      messages,
      refreshing: generating || session.conversationQuery.isFetching,
      querySettled: session.conversationQuery.isSuccess,
      dataUpdatedAt: session.conversationQuery.dataUpdatedAt,
    });
    if (next === choiceLockRef.current) return;
    commitChoiceLock(next);
  }, [
    activeSessionId,
    commitChoiceLock,
    generating,
    messages,
    session.conversationQuery.dataUpdatedAt,
    session.conversationQuery.isFetching,
    session.conversationQuery.isSuccess,
    choiceLock,
  ]);

  const handleChoice = useCallback(
    (message: ChatMessage, choice: ReplyChoicePayload) => {
      if (branch.creating || !canDispatch()) return;
      const adopted = tryAdoptChoice(choiceLockRef.current, {
        message,
        messages,
        text: choice.text,
        gates: choiceGates,
        maxLength: choiceLimit,
        baselineUpdatedAt: session.conversationQuery.dataUpdatedAt,
      });
      if (!adopted.text) return;
      // 先同步占用，再进入 runTurn。同一轮事件里的第二次点击读到的是已占用状态。
      choiceLockRef.current = adopted.state;
      setChoiceLock(adopted.state);
      void runTurn({ mode: 'send', content: adopted.text }).finally(() => {
        const next = markChoiceAwaitingConfirmation(choiceLockRef.current);
        if (next === choiceLockRef.current) return;
        choiceLockRef.current = next;
        setChoiceLock(next);
      });
    },
    [
      branch.creating,
      canDispatch,
      choiceGates,
      choiceLimit,
      messages,
      runTurn,
      session.conversationQuery.dataUpdatedAt,
    ]
  );

  const handleSend = () => {
    if (branch.creating || !canDispatch()) return;
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    void runTurn({ mode: 'send', content });
  };

  const title = resolveSessionTitle(session.conversationQuery.data?.session.title, character?.name);

  return (
    // 高度跟着可视视口走而不是写死 100dvh：iOS 弹键盘时后者不变，
    // 整页会被顶上去，sticky 顶栏就跑出屏幕了
    <div
      className="flex flex-col bg-background text-foreground"
      style={{ height: viewportHeight ? `${viewportHeight}px` : '100dvh' }}
    >
      <ChatTopBar
        backLabel={
          session.backHref === '/chats'
            ? '返回对话'
            : session.backHref === '/creation?tab=created'
              ? '返回我的创作'
              : session.backHref === '/creation?tab=favorites'
                ? '返回收藏'
                : session.backHref.startsWith('/creators/')
                  ? '返回作者空间'
                  : '返回发现'
        }
        onBack={goBack}
        characterId={characterId}
        title={title}
        characterName={character?.name}
        onOpenCharacter={() => {
          setCharacterPanelLoaded(true);
          setCharacterPanel('intro');
        }}
        onOpenSessions={() => {
          setSessionsLoaded(true);
          setSessionsOpen(true);
        }}
        returnTo={returnTo}
        generating={generating}
        freeRoundActive={freeRoundActive}
      />

      <ChatMessageList
        key={activeSessionId ?? 'pending'}
        messages={messages}
        freeZoneCatalog={modelCatalogQuery.data}
        editDisabled={generating || serverBusy || branch.creating || !session.ready}
        onEditingChange={setEditingMessage}
        viewportHeight={viewportHeight}
        characterName={character?.name ?? ''}
        characterAvatarUrl={characterAvatarUrl}
        userAvatarUrl={userAvatarUrl}
        hasMore={hasMoreEarlier}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void handleLoadEarlier()}
        awaitingFirstToken={
          generating &&
          streaming?.assistantMessageId === null &&
          !(
            lastMessage?.role === 'assistant' &&
            lastMessage.turn_index === streaming.turnIndex &&
            lastMessage.revision === streaming.revision &&
            lastMessage.request_id === streaming.requestId
          )
        }
        replyStalled={replyStalled}
        streamingMessageId={streaming?.assistantMessageId ?? null}
        quotaExhaustedNotice={quotaExhaustedNotice}
        freeZoneSwitchNotice={freeZoneSwitchNotice}
        displayName={displayName}
        replyPlanFor={(message) => planMessageReply(message, versionStates)}
        choiceDisabledFor={(message) =>
          choiceButtonsDisabled({
            message,
            messages,
            gates: choiceGates,
            lock: choiceLock,
          })
        }
        onChoice={handleChoice}
        detailsDefaultOpen={detailsDefaultOpen}
        thinkingByMessage={thinkingByMessage}
        branchFor={(message) =>
          canBranchFromMessage(message)
            ? {
                pending: branch.pendingMessageId === message.id,
                onBranch: () => {
                  if (!generating && !serverBusy && !editingMessage) void branch.fork(message);
                },
              }
            : undefined
        }
        renderFooter={(message, tools, editAction) => {
          const showVoice = canGenerateVoice(message);
          const showRegenerate = canRegenerate && message.id === lastMessage?.id;
          const showBranch = canBranchFromMessage(message);
          const showLike = canLikeMessage(message);
          if (!showVoice && !showRegenerate && !showBranch && !showLike) return null;

          return (
            <div>
              <ChatMessageVoiceFooter
                charCount={message.content.length}
                likeAction={
                  showLike ? (
                    <ChatMessageLikeButton
                      message={message}
                      onConfirmed={handleLikeConfirmed}
                      onFeedback={handleLikeFeedback}
                    />
                  ) : null
                }
                toolsAction={tools}
                editAction={editAction}
                voice={
                  showVoice
                    ? {
                        voice: voice.byMessage.get(message.id),
                        readState: voice.readState,
                        onLoad: voice.load,
                        playbackRate,
                        submitting: voice.submittingMessageId === message.id,
                        onGenerate: () => voice.generate(message.id),
                        customHref: activeSessionId
                          ? customVoicePath(characterId, message.id, {
                              sessionId: activeSessionId,
                              returnTo,
                            })
                          : null,
                        freeTrialLimit: voice.config?.next_billing.free_trial_limit ?? null,
                        hints: {
                          overLimit: voice.config?.hints?.over_limit ?? '',
                          draftFailed: voice.config?.hints?.draft_failed ?? '',
                          ttsFailed: voice.config?.hints?.tts_failed ?? '',
                        },
                      }
                    : null
                }
                regenerate={
                  showRegenerate ? (
                    <ChatRegenerateButton
                      onRegenerate={() => void runTurn({ mode: 'regenerate' })}
                      pending={false}
                      disabled={
                        generating || branch.creating || editingMessage || preferencesSaving
                      }
                      label={
                        getChatReplyPresentation(message) === 'complete' ? '换一个回复' : '重新生成'
                      }
                    />
                  ) : null
                }
              />
              {likeFeedback?.sessionId === activeSessionId &&
              likeFeedback.messageId === message.id &&
              likeFeedback.text ? (
                <p role="status" className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {likeFeedback.text}
                </p>
              ) : null}
              {branch.error?.messageId === message.id ? (
                <p role="alert" className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {branch.error.text}
                </p>
              ) : null}
            </div>
          );
        }}
      />

      {streamError ? (
        <div
          role="status"
          aria-live="polite"
          className={
            isSoftStreamNotice(streamError)
              ? 'mx-4 mb-2 flex items-center gap-2 px-3 py-2 text-muted-foreground'
              : 'mx-4 mb-2 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive'
          }
        >
          {!isSoftStreamNotice(streamError) ? (
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          ) : null}
          <span className="min-w-0 flex-1 text-[12px]">{streamError}</span>
          {streamError === FIRST_TOKEN_RETRY_MESSAGE && canRegenerate ? (
            <button
              type="button"
              onClick={() => void runTurn({ mode: 'regenerate' })}
              disabled={generating || serverBusy || branch.creating || preferencesSaving}
              className="shrink-0 text-[12px] underline decoration-current/30 underline-offset-4 hover:text-foreground disabled:opacity-50"
            >
              再试一次
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setStreamError(null)}
            aria-label="关闭提示"
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {!editingMessage ? (
        <ChatComposer
          viewportHeight={viewportHeight}
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onStop={() => void abort()}
          cancelling={cancelling}
          generating={generating}
          disabled={
            !session.ready || serverBusy || branch.creating || editingMessage || preferencesSaving
          }
          detailsDefaultOpen={detailsDefaultOpen}
          onDetailsDefaultOpenChange={handleDetailsDefaultOpenChange}
          thinkingEnabled={thinkingEnabled}
          onThinkingEnabledChange={(enabled) => {
            changeThinkingEnabled(enabled);
            thinkingNotice.onThinkingToggled(enabled);
          }}
          notice={preferencesSaving ? CHAT_PREFERENCES_SAVING : thinkingNotice.notice}
          leftSlot={<ChatToolsSheet characterId={characterId} />}
        />
      ) : null}

      {characterPanelLoaded ? (
        <CharacterDetailSheet
          characterId={characterPanel ? characterId : null}
          summary={character}
          initialTab={characterPanel ?? 'intro'}
          inConversation
          onClose={() => setCharacterPanel(null)}
          onEnter={() => setCharacterPanel(null)}
        />
      ) : null}

      {sessionsLoaded ? (
        <ChatSessionDrawer
          open={sessionsOpen}
          onOpenChange={setSessionsOpen}
          characterId={characterId}
          characterName={characterQuery.data?.character.name}
          activeSessionId={activeSessionId}
          onSelect={(nextSessionId) => {
            leaveBranchView();
            draftRecoveryRef.current = null;
            session.selectSession(nextSessionId);
          }}
          onCreateConversation={() => {
            leaveBranchView();
            draftRecoveryRef.current = null;
            session.openNewConversation();
          }}
          creating={session.createConversation.isPending}
        />
      ) : null}

      <ChatStatusPanel
        sessionId={session.ready ? activeSessionId : null}
        characterName={characterQuery.data?.character.name ?? ''}
        generating={generating}
      />

      <DramaSurveyPrompt {...{ generating, messages, userScope }} failed={streamError != null} />

      {/* 始终挂着：ChatSplash 自己负责收场动画并在结束后返回 null，条件卸载会把动画切掉 */}
      <ChatSplash
        sessionId={activeSessionId}
        backHref={session.backHref}
        characterId={characterId}
        ready={session.ready}
        error={session.entryError}
        onRetry={session.retryEntry}
      />
    </div>
  );
}
