'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { useCharacterQuery } from '@/lib/api/characters';
import { useAssistantTyping, useSendMessageMutation, useSessionQuery } from '@/lib/api/chat';
import { useUIStore } from '@/stores/ui-store';
import { useUserProfileStore } from '@/stores/user-profile-store';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram/hooks';
import { hueShiftFromId } from '@/lib/utils/character-hue';
import { useIdleDim } from '@/hooks/use-idle-dim';
import { cn } from '@/lib/utils';

import { ChatSidebar } from '@/components/chat/chat-sidebar';
import { Composer } from '@/components/chat/composer';
import { MessageList } from '@/components/chat/message-list';

export default function ChatPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const router = useRouter();

  const sessionQ = useSessionQuery(sessionId);
  const session = sessionQ.data?.session;
  const characterQ = useCharacterQuery(session?.character_id);
  const character = characterQ.data?.character;

  const sendMessage = useSendMessageMutation(sessionId);
  const isTyping = useAssistantTyping(sessionId);
  const haptic = useHaptic();
  const [showRechargePrompt, setShowRechargePrompt] = useState(false);

  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const userDisplayName = useUserProfileStore((s) => s.displayName);

  // 夜间沉浸：30s 无操作暗化 chrome
  const isDim = useIdleDim(30_000);

  // Telegram 原生返回键：推出房间，回到走廊
  const onBack = useCallback(() => {
    router.push('/');
  }, [router]);
  useTelegramBackButton(onBack);

  // "她回了"：当新出现一条 assistant 消息时，极轻触觉。
  // 首次进入页面的 greeting 不震——避免"打开即被震"的打扰。
  // 用 useMemo 稳定引用，避免 `?? []` 每次渲染都造出新数组触发 effect 白跑。
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const lastAssistantIdRef = useRef<string | null>(null);
  const hasInitRef = useRef(false);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') {
      hasInitRef.current = true;
      return;
    }
    if (lastAssistantIdRef.current === last.id) return;
    if (hasInitRef.current) {
      haptic.whisper();
    }
    lastAssistantIdRef.current = last.id;
    hasInitRef.current = true;
  }, [messages, haptic]);

  // 注入角色氛围色（供顶栏、Composer、发送键辉光引用）
  const charHue = character ? hueShiftFromId(character.id) : 12; // fallback: primary 珊瑚
  const hueVar = { ['--char-hue' as string]: `${charHue}` } as React.CSSProperties;

  const handleSend = useCallback(
    (content: string) => {
      // 发送不震动——她才是主角，你说出去的话不需要自己确认
      sendMessage.mutate(
        { content, client_message_id: newId('client-msg') },
        {
          onError: (error) => {
            if (error.message.includes('402')) {
              setShowRechargePrompt(true);
            }
          },
        }
      );
    },
    [sendMessage]
  );

  const hasAvatar = !!character?.avatar_url;

  // 双边缘滑动返回大厅:左边缘右滑 / 右边缘左滑均触发(任一向屏幕内方向 dx>64,
  // 且横向主导)。不 preventDefault,避免和 MessageList 滚动 / Composer 打架。
  const edgeSwipeStart = useRef<{ x: number; y: number; from: 'left' | 'right' } | null>(null);
  const handleEdgeTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) {
      edgeSwipeStart.current = null;
      return;
    }
    const w = window.innerWidth;
    if (t.clientX < 20) {
      edgeSwipeStart.current = { x: t.clientX, y: t.clientY, from: 'left' };
    } else if (t.clientX > w - 20) {
      edgeSwipeStart.current = { x: t.clientX, y: t.clientY, from: 'right' };
    } else {
      edgeSwipeStart.current = null;
    }
  }, []);
  const handleEdgeTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = edgeSwipeStart.current;
      edgeSwipeStart.current = null;
      if (!start) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      const triggered = (start.from === 'left' && dx > 64) || (start.from === 'right' && dx < -64);
      if (triggered) onBack();
    },
    [onBack]
  );

  return (
    <main
      className="flex h-[100dvh] flex-col"
      style={hueVar}
      onTouchStart={handleEdgeTouchStart}
      onTouchEnd={handleEdgeTouchEnd}
    >
      {/* 顶栏：头像 + 名字 + typing 副文本；渐变融入背景而非硬分界 */}
      <header
        className={cn(
          'flex items-center gap-2 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.75rem)]',
          'bg-gradient-to-b from-background via-background/92 to-background/0',
          'backdrop-blur-md transition-opacity duration-700',
          isDim ? 'opacity-40' : 'opacity-100'
        )}
      >
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="打开历史会话"
          className="-ml-1.5 grid h-11 w-11 shrink-0 place-items-center"
        >
          <span className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground">
            <DotsIcon />
          </span>
        </button>

        {/* 头像 + 名字 + 状态 */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <div
            className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-white/10"
            style={{
              boxShadow: `0 0 14px -4px hsl(var(--char-hue) 70% 60% / 0.55)`,
            }}
          >
            {hasAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={character!.avatar_url}
                alt={character!.name}
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <div
                className="h-full w-full"
                style={{
                  background: `radial-gradient(100% 100% at 50% 30%, hsl(var(--char-hue) 60% 45%), hsl(var(--char-hue) 40% 18%))`,
                }}
                aria-hidden="true"
              />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] font-medium leading-tight text-foreground/95">
              {character?.name ?? ''}
            </h1>
            <p className="truncate text-[11px] leading-tight text-muted-foreground/70">
              {isTyping ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-flex gap-0.5">
                    <span className="inline-block h-1 w-1 animate-breath rounded-full bg-[hsl(var(--char-hue)_70%_65%)] [animation-delay:-0.32s]" />
                    <span className="inline-block h-1 w-1 animate-breath rounded-full bg-[hsl(var(--char-hue)_70%_65%)] [animation-delay:-0.16s]" />
                    <span className="inline-block h-1 w-1 animate-breath rounded-full bg-[hsl(var(--char-hue)_70%_65%)]" />
                  </span>
                  <span>正在回你</span>
                </span>
              ) : (
                <span>在。</span>
              )}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onBack}
          aria-label="返回角色列表"
          className="-mr-1.5 grid h-11 w-11 shrink-0 place-items-center"
        >
          <span className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground">
            <HomeIcon />
          </span>
        </button>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto">
        {sessionQ.isLoading && messages.length === 0 ? (
          <div className="px-4 py-10">
            <div className="mx-auto flex w-24 items-center justify-center gap-1.5 py-4">
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/60 [animation-delay:-0.32s]" />
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/60 [animation-delay:-0.16s]" />
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/60" />
            </div>
          </div>
        ) : sessionQ.isError ? (
          <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            她那边好像断线了。
          </p>
        ) : (
          <MessageList
            messages={messages}
            isTyping={isTyping}
            charName={character?.name}
            userName={userDisplayName}
          />
        )}
      </section>

      <div className={cn('transition-opacity duration-700', isDim ? 'opacity-40' : 'opacity-100')}>
        <Composer
          onSend={handleSend}
          disabled={!session || sendMessage.isPending || isTyping}
          isAssistantTyping={isTyping}
        />
      </div>

      {showRechargePrompt ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] backdrop-blur-sm sm:items-center sm:pb-4">
          <div className="w-full max-w-sm rounded-3xl border border-sky-400/20 bg-slate-950/95 p-5 shadow-2xl shadow-sky-950/40">
            <div className="text-center">
              <p className="text-xs font-medium text-sky-300">星尘不足</p>
              <h2 className="mt-1 text-lg font-black text-white">需要补充星尘才能继续对话</h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                当前余额不足以完成本次模型调用。你可以去星尘商店充值，也可以先取消返回聊天。
              </p>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setShowRechargePrompt(false)}
                className="h-11 flex-1 rounded-xl border border-slate-700 bg-slate-900 text-sm font-semibold text-slate-300"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => router.push('/profile/recharge?reason=insufficient_credits')}
                className="h-11 flex-1 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 text-sm font-bold text-white shadow-lg shadow-sky-500/25"
              >
                去充值
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ChatSidebar currentSessionId={sessionId} />
    </main>
  );
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function HomeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11l9-8 9 8" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}
