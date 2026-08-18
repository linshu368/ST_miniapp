'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, X } from 'lucide-react';
import {
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  type ChatMessage,
  type GetCharacterFreeQuotaData,
} from '@miniapp/shared';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCharacterQuery } from '@/lib/api/characters';
import { ConversationStreamError, streamConversationTurn } from '@/lib/api/conversation-stream';
import {
  conversationKeys,
  fetchConversationPage,
  resolveSessionTitle,
  useConversationQuery,
  useCreateConversationMutation,
} from '@/lib/api/conversations';
import { useCharacterFreeQuotaQuery } from '@/lib/api/free-quota';
import { paymentKeys } from '@/lib/api/payment';
import { useUserSettingsQuery } from '@/lib/api/settings';
import {
  toVoiceMap,
  useGenerateVoiceMutation,
  useSessionVoiceQuery,
  useVoiceConfigQuery,
} from '@/lib/api/voice';
import { formatFreeQuotaExhaustedDialog } from '@/lib/free-quota-dialog';
import { useTelegramBackButton } from '@/lib/telegram';
import { useVisualViewportHeight } from '@/lib/use-visual-viewport-height';

const FREE_QUOTA_DIALOG_DURATION_MS = 5_000;
const REPLY_STALLED_NOTICE_MS = 15_000;

/** 流式期间叠在落库态之上的临时态。刻意不进 query cache，理由见 lib/api/conversations.ts */
interface StreamingTurn {
  /** 重生成时要把落库的最后一条 assistant 消息藏起来，换成这条正在写的 */
  mode: 'send' | 'regenerate';
  /** 本地先构造的用户气泡，start 到达后换成真 id；重生成时为 null */
  userMessage: ChatMessage | null;
  assistantMessageId: string | null;
  turnIndex: number;
  revision: number;
  text: string;
}

export default function SelfHostedChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [sessionId, setSessionId] = useState<string | null>(() => searchParams.get('session'));
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const [replyStalled, setReplyStalled] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<ChatMessage[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [freeQuotaExhaustedOpen, setFreeQuotaExhaustedOpen] = useState(false);
  const [entryAttempt, setEntryAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const characterQuery = useCharacterQuery(characterId);
  const createConversation = useCreateConversationMutation();
  const createdSessionId = createConversation.data?.session.id ?? null;
  const activeSessionId = sessionId ?? createdSessionId;
  const conversationQuery = useConversationQuery(activeSessionId ?? undefined);
  const freeQuotaQuery = useCharacterFreeQuotaQuery(characterId);
  const refetchFreeQuota = freeQuotaQuery.refetch;
  const userSettingsQuery = useUserSettingsQuery();
  const voiceConfigQuery = useVoiceConfigQuery();
  const sessionVoiceQuery = useSessionVoiceQuery(activeSessionId ?? undefined);
  const generateVoice = useGenerateVoiceMutation(activeSessionId ?? undefined);
  const viewportHeight = useVisualViewportHeight();

  const character = characterQuery.data?.character;
  const characterAvatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;
  const userAvatarUrl = userSettingsQuery.data?.settings.avatar_url ?? null;

  const goBack = useCallback(() => router.push('/'), [router]);
  useTelegramBackButton(goBack);

  const returnTo = useMemo(
    () =>
      activeSessionId
        ? `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(activeSessionId)}`
        : `/chat/${encodeURIComponent(characterId)}`,
    [characterId, activeSessionId]
  );

  /**
   * 额度快照要在 runTurn 里按调用时刻取，而 runTurn 是 useCallback——直接读
   * freeQuotaQuery.data 拿到的是创建那一帧的值（首帧通常还是 undefined）。
   * 用 ref 兜住最新值，判定「刚好在这一轮用完」才有本轮之前的基准可比。
   */
  const freeQuotaRef = useRef<GetCharacterFreeQuotaData | undefined>(undefined);
  useEffect(() => {
    freeQuotaRef.current = freeQuotaQuery.data;
  }, [freeQuotaQuery.data]);

  // ── 进入会话 ──────────────────────────────────────────────────────────────
  // 无 ?session= 就建一个新的；建完把 id 补进 URL，刷新页面不会又建一个空会话。
  // mutate 的 onSuccess 在 React Strict Mode 重挂时可能被丢掉，所以 session 以
  // mutation.data 为准；effect cleanup 必须放开 in-flight 锁，否则重挂后不会再发。
  const creatingRef = useRef(false);
  useEffect(() => {
    if (activeSessionId || !characterId || creatingRef.current) return;
    creatingRef.current = true;

    createConversation.mutate(characterId, {
      onSuccess: (data) => {
        setSessionId(data.session.id);
        window.history.replaceState(
          null,
          '',
          `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(data.session.id)}`
        );
      },
      onSettled: () => {
        creatingRef.current = false;
      },
    });

    return () => {
      creatingRef.current = false;
    };
    // createConversation 每次渲染都是新引用，只在这几项变化时重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, activeSessionId, entryAttempt]);

  useEffect(() => {
    if (sessionId || !createdSessionId) return;
    setSessionId(createdSessionId);
    window.history.replaceState(
      null,
      '',
      `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(createdSessionId)}`
    );
  }, [characterId, createdSessionId, sessionId]);

  // 会话被删或不属于当前用户：URL 里的 id 已经没用了，清掉让上面的分支重建一个
  const detailErrorCode =
    conversationQuery.error instanceof Error
      ? (conversationQuery.error as { code?: string }).code
      : undefined;
  useEffect(() => {
    if (detailErrorCode !== 'session_not_found' && detailErrorCode !== 'NOT_FOUND') return;
    setSessionId(null);
    setEarlier([]);
    window.history.replaceState(null, '', `/chat/${encodeURIComponent(characterId)}`);
  }, [characterId, detailErrorCode]);

  // 切会话时把上一段的临时态全部丢掉，包括在途的流
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
    setStreamError(null);
    setEarlier([]);
  }, [activeSessionId]);

  useEffect(() => {
    setHasMoreEarlier(conversationQuery.data?.has_more ?? false);
  }, [conversationQuery.data?.has_more]);

  // 离开页面时停掉读流。后端不会因此终止，但本地不该再往一个卸载了的组件里写
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!freeQuotaExhaustedOpen) return;
    const timer = window.setTimeout(
      () => setFreeQuotaExhaustedOpen(false),
      FREE_QUOTA_DIALOG_DURATION_MS
    );
    return () => window.clearTimeout(timer);
  }, [freeQuotaExhaustedOpen]);

  // ── 渲染用的合并列表 ──────────────────────────────────────────────────────
  const persisted = useMemo(
    () => [...earlier, ...(conversationQuery.data?.messages ?? [])],
    [earlier, conversationQuery.data?.messages]
  );

  const messages = useMemo(() => {
    if (!streaming) return persisted;

    // 重生成写的是同一轮的新版本，落库的旧版本要让位，否则会并排出现两条 assistant
    const base =
      streaming.mode === 'regenerate' && persisted.at(-1)?.role === 'assistant'
        ? persisted.slice(0, -1)
        : persisted;

    const merged = [...base];
    if (streaming.userMessage) merged.push(streaming.userMessage);
    if (streaming.assistantMessageId) {
      merged.push({
        id: streaming.assistantMessageId,
        session_id: activeSessionId ?? '',
        turn_index: streaming.turnIndex,
        role: 'assistant',
        revision: streaming.revision,
        content: streaming.text,
        status: 'streaming',
        error_code: null,
        finish_reason: null,
        model_id: null,
        created_at: new Date().toISOString(),
      });
    }
    return merged;
  }, [persisted, activeSessionId, streaming]);

  const serverBusy = persisted.some((message) => message.status === 'streaming');
  const generating = streaming !== null;
  const ready = Boolean(activeSessionId) && conversationQuery.isSuccess;

  const lastMessage = messages.at(-1);
  const replyProgressKey = streaming
    ? `local:${streaming.assistantMessageId ?? 'waiting'}:${streaming.text.length}`
    : serverBusy && lastMessage?.status === 'streaming'
      ? `server:${lastMessage.id}:${lastMessage.content.length}`
      : null;

  // 首字迟迟不到、或正文一段时间不再增长时，先给低干扰的等待提示。
  // 真正的 120 秒终止由后端负责，终态回来后再明确告知不扣费。
  useEffect(() => {
    setReplyStalled(false);
    if (!replyProgressKey) return;

    const timer = window.setTimeout(() => setReplyStalled(true), REPLY_STALLED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [replyProgressKey]);

  const canRegenerate =
    !generating && !serverBusy && lastMessage?.role === 'assistant' && lastMessage.turn_index > 0;

  // ── 角色语音 ──────────────────────────────────────────────────────────────
  const voiceByMessage = useMemo(
    () => toVoiceMap(sessionVoiceQuery.data),
    [sessionVoiceQuery.data]
  );
  const playbackRate = voiceConfigQuery.data?.config.playback_rate ?? 1;

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
      generateVoice.mutate(messageId, {
        onError: (error) => {
          // 异步阶段的失败由记录里的 failed 状态呈现，这里只管受理阶段的
          const code = (error as { code?: string }).code;
          setStreamError(
            code === 'CONFLICT'
              ? '这条回复正在生成语音'
              : code === 'VOICE_UNAVAILABLE'
                ? '语音功能暂不可用'
                : '语音生成没能开始，请重试'
          );
        },
      });
    },
    [generateVoice]
  );

  // ── 发送与重生成 ──────────────────────────────────────────────────────────

  /** start 之前失败的内容要能原样重发，还回输入框 */
  const restoreDraft = useCallback((input: { mode: 'send' | 'regenerate'; content?: string }) => {
    if (input.mode !== 'send' || !input.content) return;
    setDraft((current) => (current.trim() ? current : (input.content ?? '')));
  }, []);

  /**
   * 免费额度是否刚好在这一轮用完。后端的 done 事件不带额度信息，
   * 只能生成结束后回查一次；扣费与消息落库不在同一个事务里，所以要留一点重试余地。
   *
   * before 由调用方在发起本轮之前抓好传进来。读闭包里的 freeQuotaQuery.data 不行——
   * 那个值会被 runTurn 的 useCallback 冻住，判定条件永远不成立。
   */
  const refreshQuotaAndBalance = useCallback(
    async (before: GetCharacterFreeQuotaData | undefined): Promise<void> => {
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });

      for (const delayMs of [0, 300, 900]) {
        if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        const { data } = await refetchFreeQuota();
        if (!data || !before) return;
        if (before.used_rounds < data.quota_limit && data.used_rounds >= data.quota_limit) {
          setFreeQuotaExhaustedOpen(true);
          return;
        }
        if (data.used_rounds > before.used_rounds) return;
      }
    },
    [queryClient, refetchFreeQuota]
  );

  const handleTurnFailure = useCallback(
    async (
      error: unknown,
      input: { mode: 'send' | 'regenerate'; content?: string }
    ): Promise<void> => {
      const aborted = error instanceof Error && error.name === 'AbortError';

      // 无论怎么收场，后端都已经在写这一轮了，落库态必须重新拉一次
      setStreaming(null);
      if (activeSessionId) {
        void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(activeSessionId) });
      }
      if (aborted) return;

      if (!(error instanceof ConversationStreamError)) {
        setStreamError('网络异常，请重试');
        restoreDraft(input);
        return;
      }

      switch (error.code) {
        case 'insufficient_balance': {
          const search = new URLSearchParams({ reason: 'insufficient_credits', returnTo });
          if (error.balance) search.set('required', String(error.balance.creditsRequired));
          router.push(`/profile/recharge?${search.toString()}`);
          restoreDraft(input);
          return;
        }
        case 'session_not_found':
          setSessionId(null);
          setStreamError('这段对话已不存在，已为你开启新的对话');
          restoreDraft(input);
          return;
        case 'character_not_found':
          setStreamError('这个角色已下架');
          window.setTimeout(goBack, 1_200);
          return;
        case 'session_busy':
          setStreamError('上一条还在生成，请稍候');
          restoreDraft(input);
          return;
        case 'regenerate_not_allowed':
          setStreamError('这条回复不能重新生成了');
          return;
        default:
          setStreamError(error.message || '生成失败，请重试');
          restoreDraft(input);
      }
    },
    [goBack, queryClient, restoreDraft, returnTo, router, activeSessionId]
  );

  const runTurn = useCallback(
    async (input: { mode: 'send' | 'regenerate'; content?: string }) => {
      if (!activeSessionId) return;

      // 本轮之前的额度。生成结束后要拿它跟新值比，判断额度是不是刚好在这一轮见底
      const quotaBefore = freeQuotaRef.current;

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamError(null);

      const optimisticUser: ChatMessage | null =
        input.mode === 'send' && input.content !== undefined
          ? {
              id: `local:${Date.now()}`,
              session_id: activeSessionId,
              turn_index: Number.MAX_SAFE_INTEGER,
              role: 'user',
              revision: 0,
              content: input.content,
              status: 'complete',
              error_code: null,
              finish_reason: null,
              model_id: null,
              created_at: new Date().toISOString(),
            }
          : null;

      setStreaming({
        mode: input.mode,
        userMessage: optimisticUser,
        assistantMessageId: null,
        turnIndex: 0,
        revision: 0,
        text: '',
      });

      try {
        await streamConversationTurn({
          sessionId: activeSessionId,
          content: input.content,
          signal: controller.signal,
          onStart: (event) => {
            setStreaming((current) =>
              current
                ? {
                    ...current,
                    assistantMessageId: event.assistant_message_id,
                    turnIndex: event.turn_index,
                    revision: event.revision,
                    userMessage: current.userMessage
                      ? {
                          ...current.userMessage,
                          id: event.user_message_id ?? current.userMessage.id,
                          turn_index: event.turn_index,
                          revision: event.revision,
                        }
                      : null,
                  }
                : current
            );
          },
          onDelta: (text) => {
            setStreaming((current) =>
              current ? { ...current, text: current.text + text } : current
            );
          },
          onDone: () => undefined,
        });

        // 先等落库态回来再撤临时态，顺序反过来中间会闪一帧空白
        await queryClient.invalidateQueries({ queryKey: conversationKeys.detail(activeSessionId) });
        setStreaming(null);
        void refreshQuotaAndBalance(quotaBefore);
      } catch (error) {
        await handleTurnFailure(error, input);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [activeSessionId, handleTurnFailure, queryClient, refreshQuotaAndBalance]
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

  const openNewConversation = () => {
    createConversation.mutate(characterId, {
      onSuccess: (data) => {
        setSessionId(data.session.id);
        window.history.replaceState(
          null,
          '',
          `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(data.session.id)}`
        );
      },
    });
  };

  const exhaustedDialog = formatFreeQuotaExhaustedDialog(
    freeQuotaQuery.data?.exhausted_dialog ?? DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
    character?.name
  );

  // 进入失败要能重试。session_not_found 不算失败——上面的分支会自动重建一个新会话
  const entryError = createConversation.isError
    ? '对话创建失败，请重试'
    : conversationQuery.isError && !detailErrorCode
      ? '对话加载失败，请重试'
      : null;

  const title = resolveSessionTitle(conversationQuery.data?.session.title, character?.name);

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
                      submitting: generateVoice.isPending && generateVoice.variables === message.id,
                      onGenerate: () => handleGenerateVoice(message.id),
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
        onStop={() => abortRef.current?.abort()}
        generating={generating}
        disabled={!ready || serverBusy}
        leftSlot={
          <ChatToolsSheet
            returnTo={returnTo}
            onCreateConversation={openNewConversation}
            creating={createConversation.isPending}
          />
        }
      />

      <ChatSessionDrawer
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        characterId={characterId}
        characterName={characterQuery.data?.character.name}
        activeSessionId={activeSessionId}
        onSelect={(nextSessionId) => {
          setSessionId(nextSessionId);
          window.history.replaceState(
            null,
            '',
            `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(nextSessionId)}`
          );
        }}
      />

      {/* 始终挂着：ChatSplash 自己负责收场动画并在结束后返回 null，条件卸载会把动画切掉 */}
      <ChatSplash
        characterId={characterId}
        ready={ready}
        error={entryError}
        onRetry={() => {
          createConversation.reset();
          setEntryAttempt((attempt) => attempt + 1);
          if (activeSessionId) void conversationQuery.refetch();
        }}
      />

      <Dialog open={freeQuotaExhaustedOpen} onOpenChange={setFreeQuotaExhaustedOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100%-2rem)] max-w-sm rounded-2xl border-primary/40 bg-primary text-primary-foreground"
        >
          <DialogHeader className="items-stretch text-left">
            <DialogTitle className="leading-6">{exhaustedDialog.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line pt-1 text-left leading-6 text-primary-foreground/80">
              {exhaustedDialog.description}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}
