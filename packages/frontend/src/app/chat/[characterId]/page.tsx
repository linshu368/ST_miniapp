'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, X } from 'lucide-react';
import { DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG, type ChatMessage } from '@miniapp/shared';
import { useQueryClient } from '@tanstack/react-query';

import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatMessageList } from '@/components/chat/chat-message-list';
import { ChatRegenerateButton } from '@/components/chat/chat-regenerate-button';
import { ChatSessionDrawer } from '@/components/chat/chat-session-drawer';
import { ChatTopBar } from '@/components/chat/chat-top-bar';
import { ChatSplash } from '@/components/tavern/chat-splash';
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
import { formatFreeQuotaExhaustedDialog } from '@/lib/free-quota-dialog';
import { useTelegramBackButton } from '@/lib/telegram';

const FREE_QUOTA_DIALOG_DURATION_MS = 5_000;

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
  const [streamError, setStreamError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<ChatMessage[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [freeQuotaExhaustedOpen, setFreeQuotaExhaustedOpen] = useState(false);
  const [entryAttempt, setEntryAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const characterQuery = useCharacterQuery(characterId);
  const conversationQuery = useConversationQuery(sessionId ?? undefined);
  const createConversation = useCreateConversationMutation();
  const freeQuotaQuery = useCharacterFreeQuotaQuery(characterId);

  const goBack = useCallback(() => router.push('/'), [router]);
  useTelegramBackButton(goBack);

  const returnTo = sessionId
    ? `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(sessionId)}`
    : `/chat/${encodeURIComponent(characterId)}`;

  // ── 进入会话 ──────────────────────────────────────────────────────────────
  // 无 ?session= 就建一个新的；建完把 id 补进 URL，刷新页面不会又建一个空会话。
  const creatingRef = useRef(false);
  useEffect(() => {
    if (sessionId || !characterId || creatingRef.current) return;
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
    // createConversation 每次渲染都是新引用，只在这几项变化时重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, sessionId, entryAttempt]);

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
  }, [sessionId]);

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
        session_id: sessionId ?? '',
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
  }, [persisted, sessionId, streaming]);

  const serverBusy = persisted.some((message) => message.status === 'streaming');
  const generating = streaming !== null;
  const ready = Boolean(sessionId) && conversationQuery.isSuccess;

  const lastMessage = messages.at(-1);
  const canRegenerate =
    !generating && !serverBusy && lastMessage?.role === 'assistant' && lastMessage.turn_index > 0;

  // ── 发送与重生成 ──────────────────────────────────────────────────────────
  const runTurn = useCallback(
    async (input: { mode: 'send' | 'regenerate'; content?: string }) => {
      if (!sessionId) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamError(null);

      const optimisticUser: ChatMessage | null =
        input.mode === 'send' && input.content !== undefined
          ? {
              id: `local:${Date.now()}`,
              session_id: sessionId,
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
          sessionId,
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
        await queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
        setStreaming(null);
        void refreshQuotaAndBalance();
      } catch (error) {
        await handleTurnFailure(error, input);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    // handleTurnFailure / refreshQuotaAndBalance 在下面定义且只依赖稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, queryClient]
  );

  /**
   * 免费额度是否刚好在这一轮用完。后端的 done 事件不带额度信息，
   * 只能生成结束后回查一次；扣费与消息落库不在同一个事务里，所以要留一点重试余地。
   */
  async function refreshQuotaAndBalance(): Promise<void> {
    void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });

    const before = freeQuotaQuery.data;
    for (const delayMs of [0, 300, 900]) {
      if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      const { data } = await freeQuotaQuery.refetch();
      if (!data || !before) return;
      if (before.used_rounds < data.quota_limit && data.used_rounds >= data.quota_limit) {
        setFreeQuotaExhaustedOpen(true);
        return;
      }
      if (data.used_rounds > before.used_rounds) return;
    }
  }

  async function handleTurnFailure(
    error: unknown,
    input: { mode: 'send' | 'regenerate'; content?: string }
  ): Promise<void> {
    const aborted = error instanceof Error && error.name === 'AbortError';

    // 无论怎么收场，后端都已经在写这一轮了，落库态必须重新拉一次
    setStreaming(null);
    if (sessionId) {
      void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
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
  }

  /** start 之前失败的内容要能原样重发，还回输入框 */
  function restoreDraft(input: { mode: 'send' | 'regenerate'; content?: string }): void {
    if (input.mode !== 'send' || !input.content) return;
    setDraft((current) => (current.trim() ? current : (input.content ?? '')));
  }

  const handleSend = () => {
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    void runTurn({ mode: 'send', content });
  };

  const handleLoadEarlier = async () => {
    const oldest = persisted[0];
    if (!sessionId || !oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await fetchConversationPage(sessionId, oldest.turn_index);
      setEarlier((current) => [...page.messages, ...current]);
      setHasMoreEarlier(page.has_more);
    } catch {
      setStreamError('更早的消息没能加载出来');
    } finally {
      setLoadingEarlier(false);
    }
  };

  const exhaustedDialog = formatFreeQuotaExhaustedDialog(
    freeQuotaQuery.data?.exhausted_dialog ?? DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
    characterQuery.data?.character.name
  );

  // 进入失败要能重试。session_not_found 不算失败——上面的分支会自动重建一个新会话
  const entryError = createConversation.isError
    ? '对话创建失败，请重试'
    : conversationQuery.isError && !detailErrorCode
      ? '对话加载失败，请重试'
      : null;

  const title = conversationQuery.data
    ? resolveSessionTitle(
        conversationQuery.data.session.title,
        conversationQuery.data.session.last_message_preview,
        characterQuery.data?.character.name ?? ''
      )
    : (characterQuery.data?.character.name ?? '');

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <ChatTopBar
        characterId={characterId}
        title={title}
        onOpenSessions={() => setSessionsOpen(true)}
        returnTo={returnTo}
      />

      <ChatMessageList
        messages={messages}
        hasMore={hasMoreEarlier}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void handleLoadEarlier()}
        awaitingFirstToken={generating && streaming?.assistantMessageId === null}
        streamingMessageId={streaming?.assistantMessageId ?? null}
        renderFooter={(message) =>
          canRegenerate && message.id === lastMessage?.id ? (
            <ChatRegenerateButton
              onRegenerate={() => void runTurn({ mode: 'regenerate' })}
              pending={false}
              disabled={generating}
            />
          ) : null
        }
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
      />

      <ChatSessionDrawer
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        characterId={characterId}
        activeSessionId={sessionId}
        creating={createConversation.isPending}
        onSelect={(nextSessionId) => {
          setSessionId(nextSessionId);
          window.history.replaceState(
            null,
            '',
            `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(nextSessionId)}`
          );
        }}
        onCreate={() => {
          createConversation.mutate(characterId, {
            onSuccess: (data) => {
              setSessionsOpen(false);
              setSessionId(data.session.id);
              window.history.replaceState(
                null,
                '',
                `/chat/${encodeURIComponent(characterId)}?session=${encodeURIComponent(data.session.id)}`
              );
            },
          });
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
          if (sessionId) void conversationQuery.refetch();
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
