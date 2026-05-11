'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { useCharacterQuery } from '@/lib/api/characters';
import { useAssistantTyping, useSendMessageMutation, useSessionQuery } from '@/lib/api/chat';
import { useUIStore } from '@/stores/ui-store';
import { useUserProfileStore } from '@/stores/user-profile-store';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram/hooks';

import { ChatCharacterProfile } from '@/components/chat/chat-character-profile';
import { ChatSidebar } from '@/components/chat/chat-sidebar';
import { Composer } from '@/components/chat/composer';
import { GridMenu } from '@/components/chat/grid-menu';
import { MessageList } from '@/components/chat/message-list';

const NOIR_BG = 'radial-gradient(120% 60% at 50% 0%, #16191F 0%, #0B0D11 55%)';

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

  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const userDisplayName = useUserProfileStore((s) => s.displayName);

  const onBack = useCallback(() => {
    router.push('/');
  }, [router]);
  useTelegramBackButton(onBack);

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

  const handleSend = useCallback(
    (content: string) => {
      sendMessage.mutate({ content });
    },
    [sendMessage]
  );

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
      className="chat-noir mx-auto flex h-[100dvh] w-full max-w-md flex-col font-sans text-[#F2F3F5]"
      style={{ background: NOIR_BG }}
      onTouchStart={handleEdgeTouchStart}
      onTouchEnd={handleEdgeTouchEnd}
    >
      <header className="grid w-full shrink-0 grid-cols-[40px_1fr_40px] items-center px-6 pb-5 pt-[calc(env(safe-area-inset-top)+20px)]">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="打开历史会话"
          className="flex h-10 w-10 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0D11]"
        >
          <span className="flex flex-col gap-1" aria-hidden>
            <span className="h-1 w-1 rounded-full bg-[rgba(242,243,245,0.32)]" />
            <span className="h-1 w-1 rounded-full bg-[rgba(242,243,245,0.32)]" />
            <span className="h-1 w-1 rounded-full bg-[rgba(242,243,245,0.32)]" />
          </span>
        </button>

        <div className="flex min-h-[40px] min-w-0 items-center justify-center px-1 text-center">
          {isTyping ? (
            <p
              className="truncate font-light text-[14px] text-[rgba(242,243,245,0.4)]"
              style={{ letterSpacing: '2px' }}
            >
              正在回你
            </p>
          ) : (
            <p
              className="font-light text-[14px] text-[rgba(242,243,245,0.4)]"
              style={{ letterSpacing: '2px' }}
            >
              在。
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onBack}
          aria-label="返回角色列表"
          className="flex h-10 w-10 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0D11]"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-[4px] border-[1.3px] border-[rgba(242,243,245,0.3)] text-[rgba(242,243,245,0.85)]">
            <HomeIcon />
          </span>
        </button>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto">
        {sessionQ.isLoading && messages.length === 0 ? (
          <div className="px-4 py-10">
            <div className="mx-auto flex w-24 items-center justify-center gap-1.5 py-4">
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-[rgba(242,243,245,0.35)] [animation-delay:-0.32s]" />
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-[rgba(242,243,245,0.35)] [animation-delay:-0.16s]" />
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-[rgba(242,243,245,0.35)]" />
            </div>
          </div>
        ) : sessionQ.isError ? (
          <p className="px-4 py-10 text-center text-[13px] text-[rgba(242,243,245,0.55)]">
            她那边好像断线了。
          </p>
        ) : (
          <>
            <ChatCharacterProfile
              character={character}
              isLoading={characterQ.isLoading && !!session?.character_id}
            />
            <MessageList
              messages={messages}
              isTyping={isTyping}
              charName={character?.name}
              userName={userDisplayName}
              charAvatarUrl={character?.avatar_url}
              characterId={character?.id}
              variant="noir"
            />
          </>
        )}
      </section>

      <Composer
        onSend={handleSend}
        disabled={!session || sendMessage.isPending || isTyping}
        isAssistantTyping={isTyping}
        variant="noir"
        charName={character?.name}
        leftSlot={<GridMenu charName={character?.name} />}
      />

      <ChatSidebar currentSessionId={sessionId} />
    </main>
  );
}

function HomeIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11l9-8 9 8" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}
