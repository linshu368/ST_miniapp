'use client';

import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Home, MoreHorizontal } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';

import { useCharacterQuery } from '@/lib/api/characters';
import { useAssistantTyping, useSendMessageMutation, useSessionQuery } from '@/lib/api/chat';
import { useUIStore } from '@/stores/ui-store';
import { useUserProfileStore } from '@/stores/user-profile-store';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram/hooks';

import { hueShiftFromId } from '@/lib/utils/character-hue';

import { ChatCharacterProfile } from '@/components/chat/chat-character-profile';
import { ChatSidebar } from '@/components/chat/chat-sidebar';
import { Composer } from '@/components/chat/composer';
import { GridMenu } from '@/components/chat/grid-menu';
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

  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const userDisplayName = useUserProfileStore((s) => s.displayName);

  const onBack = useCallback(() => {
    router.push('/');
  }, [router]);
  useTelegramBackButton(onBack);

  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);

  const hueVar = useMemo(
    () =>
      ({
        '--char-hue': character?.id ? hueShiftFromId(character.id) : 12,
      }) as CSSProperties,
    [character?.id]
  );
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
      className="chat-noir mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden font-sans text-foreground"
      style={{
        ...hueVar,
        background: 'radial-gradient(ellipse at 50% 30%, #1e2a3a 0%, #0d0f14 70%)',
      }}
      onTouchStart={handleEdgeTouchStart}
      onTouchEnd={handleEdgeTouchEnd}
    >
      <header className="grid w-full shrink-0 grid-cols-[40px_1fr_40px] items-center border-b border-white/8 bg-black/20 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="打开历史会话"
          className="flex h-10 w-10 items-center justify-center text-[#8a9bb0] outline-none transition-colors hover:text-white/70 focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-0"
        >
          <MoreHorizontal className="h-5 w-5" strokeWidth={1.5} aria-hidden />
        </button>

        <div className="flex min-h-[40px] min-w-0 items-center justify-center px-1 text-center">
          {isTyping ? (
            <h1 className="truncate text-sm font-semibold tracking-wider text-white">正在回你</h1>
          ) : (
            <h1 className="text-sm font-semibold tracking-wider text-white">在。</h1>
          )}
        </div>

        <button
          type="button"
          onClick={onBack}
          aria-label="返回角色列表"
          className="flex h-10 w-10 items-center justify-center text-[#8a9bb0] outline-none transition-colors hover:text-white/70 focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-0"
        >
          <Home className="h-5 w-5" strokeWidth={1.5} aria-hidden />
        </button>
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto">
        {sessionQ.isLoading && messages.length === 0 ? (
          <div className="px-6 py-10">
            <div className="mx-auto flex w-24 items-center justify-center gap-1.5 py-4">
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/35 [animation-delay:-0.32s]" />
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/35 [animation-delay:-0.16s]" />
              <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/35" />
            </div>
          </div>
        ) : sessionQ.isError ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">她那边好像断线了。</p>
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

      <div className="w-full shrink-0">
        <Composer
          onSend={handleSend}
          disabled={!session || sendMessage.isPending || isTyping}
          isAssistantTyping={isTyping}
          variant="noir"
          charName={character?.name}
          leftSlot={<GridMenu charName={character?.name} />}
        />
      </div>

      <ChatSidebar currentSessionId={sessionId} />
    </main>
  );
}
