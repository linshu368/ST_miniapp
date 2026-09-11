'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, X } from 'lucide-react';
import type { ChatMessage } from '@miniapp/shared';
import { useQueryClient } from '@tanstack/react-query';

import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatMessageList } from '@/components/chat/chat-message-list';
import { ChatMessageVoiceFooter } from '@/components/chat/chat-message-voice';
import { getChatReplyPresentation } from '@/components/chat/chat-reply-presentation';
import { ChatRegenerateButton } from '@/components/chat/chat-regenerate-button';
import { ChatSessionDrawer } from '@/components/chat/chat-session-drawer';
import { ChatToolsSheet } from '@/components/chat/chat-tools-sheet';
import { ChatTopBar } from '@/components/chat/chat-top-bar';
import { lobbyImageUrl } from '@/components/characters/character-card';
import { ChatSplash } from '@/components/chat/chat-splash';
import { useChatSession } from '@/hooks/use-chat-session';
import { useConversationTurn } from '@/hooks/use-conversation-turn';
import { useCharacterQuery } from '@/lib/api/characters';
import { fetchConversationPage, resolveSessionTitle } from '@/lib/api/conversations';
import { paymentKeys } from '@/lib/api/payment';
import { useUserSettingsQuery } from '@/lib/api/settings';
import {
  toVoiceMap,
  useGenerateVoiceMutation,
  useSessionVoiceQuery,
  useVoiceConfigQuery,
} from '@/lib/api/voice';
import { customVoicePath } from '@/lib/chat-entry';
import { redirectToRechargeFromError } from '@/lib/recharge-redirect';
import { useTelegramBackButton } from '@/lib/telegram';
import { useVisualViewportHeight } from '@/lib/use-visual-viewport-height';

export default function SelfHostedChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState('');
  const [earlier, setEarlier] = useState<ChatMessage[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const session = useChatSession(characterId);
  const { activeSessionId, returnTo } = session;

  const persisted = useMemo(
    () => [...earlier, ...(session.conversationQuery.data?.messages ?? [])],
    [earlier, session.conversationQuery.data?.messages]
  );

  const goBack = useCallback(() => router.push('/'), [router]);
  useTelegramBackButton(goBack);

  const restoreSendContent = useCallback((content: string) => {
    setDraft((current) => (current.trim() ? current : content));
  }, []);

  const characterQuery = useCharacterQuery(characterId);
  const character = characterQuery.data?.character;

  const {
    abort,
    canRegenerate,
    generating,
    lastMessage,
    messages,
    quotaExhaustedNotice,
    replyStalled,
    runTurn,
    serverBusy,
    setStreamError,
    streamError,
    streaming,
  } = useConversationTurn({
    characterId,
    characterName: character?.name,
    sessionId: activeSessionId,
    persistedMessages: persisted,
    returnTo,
    onSessionGone: session.abandonSession,
    goBack,
    onRestoreSendContent: restoreSendContent,
  });

  const userSettingsQuery = useUserSettingsQuery();
  const voiceConfigQuery = useVoiceConfigQuery();
  const sessionVoiceQuery = useSessionVoiceQuery(activeSessionId ?? undefined);
  const generateVoice = useGenerateVoiceMutation(activeSessionId ?? undefined);
  const viewportHeight = useVisualViewportHeight();

  const characterAvatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;
  const userAvatarUrl = userSettingsQuery.data?.settings.avatar_url ?? null;

  useEffect(() => {
    setEarlier([]);
  }, [activeSessionId]);

  useEffect(() => {
    if (
      session.detailErrorCode !== 'session_not_found' &&
      session.detailErrorCode !== 'NOT_FOUND'
    ) {
      return;
    }
    setEarlier([]);
  }, [session.detailErrorCode]);

  useEffect(() => {
    setHasMoreEarlier(session.conversationQuery.data?.has_more ?? false);
  }, [session.conversationQuery.data?.has_more]);

  const voiceByMessage = useMemo(
    () => toVoiceMap(sessionVoiceQuery.data),
    [sessionVoiceQuery.data]
  );
  const playbackRate = voiceConfigQuery.data?.config.playback_rate ?? 1;
  const voicePriceLabel = voiceConfigQuery.data?.billing?.enabled
    ? voiceConfigQuery.data?.billing?.price_label
    : '';

  useEffect(() => {
    const charged = sessionVoiceQuery.data?.audio.some((item) => item.credits_charged > 0);
    if (charged) void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
  }, [queryClient, sessionVoiceQuery.data]);

  /**
   * 哪些消息能生成语音。turn_index > 0 排掉开场白，status 排掉正在写和没写完的——
   * 后端认的 messageId 是 chat_history 行 id，这两类要么不是库里的行，要么没有正文。
   */
  const canGenerateVoice = useCallback(
    (message: ChatMessage): boolean =>
      getChatReplyPresentation(message) === 'complete' && message.turn_index > 0,
    []
  );

  const handleGenerateVoice = useCallback(
    (messageId: string) => {
      generateVoice.mutate(
        { messageId },
        {
          onError: (error) => {
            // 异步阶段的失败由记录里的 failed 状态呈现，这里只管受理阶段的
            if (redirectToRechargeFromError(router, error, returnTo)) return;
            const code = (error as { code?: string }).code;
            setStreamError(
              code === 'CONFLICT'
                ? '这条回复正在生成语音'
                : code === 'VOICE_UNAVAILABLE'
                  ? '语音功能暂不可用'
                  : '语音生成没能开始，请重试'
            );
          },
        }
      );
    },
    [generateVoice, returnTo, router, setStreamError]
  );

  const handleSend = () => {
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    void runTurn({ mode: 'send', content });
  };

  const handleLoadEarlier = async () => {
    const oldest = persisted[0];
    if (!activeSessionId || !oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await fetchConversationPage(activeSessionId, oldest.turn_index);
      setEarlier((current) => [...page.messages, ...current]);
      setHasMoreEarlier(page.has_more);
    } catch {
      setStreamError('更早的消息没能加载出来');
    } finally {
      setLoadingEarlier(false);
    }
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
        characterId={characterId}
        title={title}
        onOpenSessions={() => setSessionsOpen(true)}
      />

      <ChatMessageList
        messages={messages}
        characterName={character?.name ?? ''}
        characterAvatarUrl={characterAvatarUrl}
        userAvatarUrl={userAvatarUrl}
        hasMore={hasMoreEarlier}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void handleLoadEarlier()}
        awaitingFirstToken={generating && streaming?.assistantMessageId === null}
        replyStalled={replyStalled}
        streamingMessageId={streaming?.assistantMessageId ?? null}
        quotaExhaustedNotice={quotaExhaustedNotice}
        renderFooter={(message) => {
          const showVoice = canGenerateVoice(message);
          const showRegenerate = canRegenerate && message.id === lastMessage?.id;
          if (!showVoice && !showRegenerate) return null;

          return (
            <ChatMessageVoiceFooter
              charCount={message.content.length}
              voice={
                showVoice
                  ? {
                      voice: voiceByMessage.get(message.id),
                      playbackRate,
                      submitting:
                        generateVoice.isPending &&
                        generateVoice.variables?.messageId === message.id,
                      onGenerate: () => handleGenerateVoice(message.id),
                      customHref: activeSessionId
                        ? customVoicePath(characterId, message.id, {
                            sessionId: activeSessionId,
                            returnTo,
                          })
                        : null,
                      priceLabel: voicePriceLabel,
                      hints: {
                        overLimit: voiceConfigQuery.data?.hints?.over_limit ?? '',
                        draftFailed: voiceConfigQuery.data?.hints?.draft_failed ?? '',
                        ttsFailed: voiceConfigQuery.data?.hints?.tts_failed ?? '',
                      },
                    }
                  : null
              }
              regenerate={
                showRegenerate ? (
                  <ChatRegenerateButton
                    onRegenerate={() => void runTurn({ mode: 'regenerate' })}
                    pending={false}
                    disabled={generating}
                    label={
                      getChatReplyPresentation(message) === 'complete' ? '换一个回复' : '重新回复'
                    }
                  />
                ) : null
              }
            />
          );
        }}
      />

      {streamError ? (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 flex-1 text-[12px] text-destructive">{streamError}</span>
          <button
            type="button"
            onClick={() => setStreamError(null)}
            aria-label="关闭提示"
            className="shrink-0 text-destructive/70 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        onStop={abort}
        generating={generating}
        disabled={!session.ready || serverBusy}
        leftSlot={
          <ChatToolsSheet
            returnTo={returnTo}
            onCreateConversation={session.openNewConversation}
            creating={session.createConversation.isPending}
          />
        }
      />

      <ChatSessionDrawer
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        characterId={characterId}
        characterName={characterQuery.data?.character.name}
        activeSessionId={activeSessionId}
        onSelect={session.selectSession}
      />

      {/* 始终挂着：ChatSplash 自己负责收场动画并在结束后返回 null，条件卸载会把动画切掉 */}
      <ChatSplash
        characterId={characterId}
        ready={session.ready}
        error={session.entryError}
        onRetry={session.retryEntry}
      />
    </div>
  );
}
