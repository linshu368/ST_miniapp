'use client';

import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Home as HomeIcon, MoreHorizontal as DotsIcon } from 'lucide-react';
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

/** 与 `app/layout.tsx` 根内容区 `max-w-[390px]` 一致：边缘手势要贴着「聊天列」而非整屏最外缘 */
const APP_COLUMN_MAX_PX = 390;

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
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const sidebarDragX = useUIStore((s) => s.sidebarDragX);
  const isSidebarDragging = useUIStore((s) => s.isSidebarDragging);
  const setSidebarDragX = useUIStore((s) => s.setSidebarDragX);
  const setIsSidebarDragging = useUIStore((s) => s.setIsSidebarDragging);
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

  // 边缘横滑：用触摸带 + identifier 匹配。
  // - touchstart 必须用 changedTouches（新按下的一根），不能用 touches[0]（多指时可能是另一根）。
  // - touchend 必须在 changedTouches 里找同一 identifier；Telegram/WebView 里纯 window 监听在屏幕最边缘也常收不到触摸。
  const onBackRef = useRef(onBack);
  const setSidebarOpenRef = useRef(setSidebarOpen);
  const setSidebarDragXRef = useRef(setSidebarDragX);
  const setIsSidebarDraggingRef = useRef(setIsSidebarDragging);
  onBackRef.current = onBack;
  setSidebarOpenRef.current = setSidebarOpen;
  setSidebarDragXRef.current = setSidebarDragX;
  setIsSidebarDraggingRef.current = setIsSidebarDragging;

  const edgeSwipeRef = useRef<{
    id: number;
    x: number;
    y: number;
    from: 'left' | 'right';
    viewportWidth: number;
  } | null>(null);

  const edgeStripVerticalStyle = useMemo(
    () =>
      ({
        top: 'calc(env(safe-area-inset-top) + 56px)',
        bottom: 'calc(env(safe-area-inset-bottom) + 100px)',
        touchAction: 'none',
      }) as const,
    []
  );

  const edgeStripSideStyleLeft = useMemo(
    () =>
      ({
        ...edgeStripVerticalStyle,
        left: `max(0px, calc((100vw - ${APP_COLUMN_MAX_PX}px) / 2))`,
        width: '50vw',
      }) as const,
    [edgeStripVerticalStyle]
  );

  const edgeStripSideStyleRight = useMemo(
    () =>
      ({
        ...edgeStripVerticalStyle,
        right: `max(0px, calc((100vw - ${APP_COLUMN_MAX_PX}px) / 2))`,
        width: '50vw',
      }) as const,
    [edgeStripVerticalStyle]
  );

  const EDGE_ZONE = 60; // 只响应从屏幕边缘 60px 内开始的滑动
  const DISMISS_THRESHOLD = 48; // 最小滑动距离

  const handleEdgeStripStart = useCallback((from: 'left' | 'right', e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    if (!t) return;

    // 检查触摸起始位置是否真的在屏幕边缘
    const screenW = window.innerWidth;
    if (from === 'right' && t.clientX < screenW - EDGE_ZONE) return;
    if (from === 'left' && t.clientX > EDGE_ZONE) return;

    edgeSwipeRef.current = {
      id: t.identifier,
      x: t.clientX,
      y: t.clientY,
      from,
      viewportWidth: screenW,
    };
    setIsSidebarDraggingRef.current(true);
  }, []);

  const handleMainTouchMove = useCallback((e: React.TouchEvent) => {
    const start = edgeSwipeRef.current;
    if (!start) return;

    // 找到对应的触摸点
    let t: React.Touch | undefined;
    for (let i = 0; i < e.touches.length; i++) {
      const c = e.touches.item(i);
      if (c?.identifier === start.id) {
        t = c;
        break;
      }
    }
    if (!t) return;

    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    // 只处理水平滑动（忽略垂直滑动）
    if (Math.abs(dx) <= Math.abs(dy) * 1.15) return;

    if (start.from === 'right' && dx < 0) {
      // 右边缘左滑：计算侧栏偏移量
      // 侧栏宽度是 72vw，最大 280px
      const sidebarWidth = Math.min(start.viewportWidth * 0.72, 280);
      // 滑动距离映射到侧栏位移（从 translateX(100%) 到 translateX(0)）
      const dragX = Math.max(0, Math.min(sidebarWidth, Math.abs(dx)));
      setSidebarDragXRef.current(dragX);
      e.preventDefault();
    } else if (start.from === 'left' && dx > 0) {
      // 左边缘右滑：直接触发返回（不需要跟手）
      if (dx > DISMISS_THRESHOLD) {
        edgeSwipeRef.current = null;
        setIsSidebarDraggingRef.current(false);
        setSidebarDragXRef.current(0);
        onBackRef.current();
      }
    }
  }, []);

  const handleMainTouchEnd = useCallback((e: React.TouchEvent) => {
    const start = edgeSwipeRef.current;
    if (!start) return;

    // 找到对应的触摸点
    let t: React.Touch | undefined;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const c = e.changedTouches.item(i);
      if (c?.identifier === start.id) {
        t = c;
        break;
      }
    }
    if (!t) {
      edgeSwipeRef.current = null;
      setIsSidebarDraggingRef.current(false);
      setSidebarDragXRef.current(0);
      return;
    }

    edgeSwipeRef.current = null;
    setIsSidebarDraggingRef.current(false);

    if (start.from === 'right') {
      const sidebarWidth = Math.min(start.viewportWidth * 0.72, 280);
      const dx = t.clientX - start.x;

      // 如果滑动超过侧栏宽度的 40%，打开侧栏
      if (Math.abs(dx) > sidebarWidth * 0.4) {
        setSidebarDragXRef.current(0);
        setSidebarOpenRef.current(true);
      } else {
        // 否则回弹
        setSidebarDragXRef.current(0);
      }
    } else {
      setSidebarDragXRef.current(0);
    }
  }, []);

  const handleMainTouchCancel = useCallback((e: React.TouchEvent) => {
    const start = edgeSwipeRef.current;
    if (!start) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const c = e.changedTouches.item(i);
      if (c?.identifier === start.id) {
        edgeSwipeRef.current = null;
        setIsSidebarDraggingRef.current(false);
        setSidebarDragXRef.current(0);
        return;
      }
    }
  }, []);

  return (
    <main
      className="chat-noir relative mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden font-sans text-foreground"
      style={{
        ...hueVar,
        background: 'radial-gradient(ellipse at 50% 30%, #1e2a3a 0%, #0d0f14 70%)',
      }}
      onTouchMove={handleMainTouchMove}
      onTouchEnd={handleMainTouchEnd}
      onTouchCancel={handleMainTouchCancel}
    >
      {/* 触摸带对齐居中聊天列（layout max-w-[390px]），而非视口 left:0/right:0；宽屏上从列右缘左划才能命中 */}
      <div
        aria-hidden
        className="pointer-events-auto fixed z-[25] touch-none"
        style={edgeStripSideStyleLeft}
        onTouchStart={(e) => handleEdgeStripStart('left', e)}
      />
      <div
        aria-hidden
        className="pointer-events-auto fixed z-[25] touch-none"
        style={edgeStripSideStyleRight}
        onTouchStart={(e) => handleEdgeStripStart('right', e)}
      />

      <header className="relative z-30 grid w-full shrink-0 grid-cols-[auto_1fr_auto] items-center border-b border-white/8 bg-black/20 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回角色列表"
          className="-ml-1.5 grid h-11 w-11 shrink-0 place-items-center"
        >
          <span className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground">
            <HomeIcon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
          </span>
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
          onClick={toggleSidebar}
          aria-label="打开历史会话"
          className="-mr-1.5 grid h-11 w-11 shrink-0 place-items-center"
        >
          <span className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground">
            <DotsIcon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
          </span>
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

      <ChatSidebar
        currentSessionId={sessionId}
        externalDragX={isSidebarDragging ? sidebarDragX : undefined}
      />
    </main>
  );
}
