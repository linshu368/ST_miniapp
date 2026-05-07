'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

import {
  useDeleteSessionMutation,
  useSessionsQuery,
  useUpdateSessionMutation,
} from '@/lib/api/chat';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';

import { SessionRow } from './session-row';
import { RenameDialog, SessionRowMenu } from './session-row-menu';

// 折叠状态持久化(localStorage)
const PINNED_KEY = 'st_sidebar_pinned_expanded';
const RECENT_KEY = 'st_sidebar_recent_expanded';
const readExpanded = (key: string): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
};
const writeExpanded = (key: string, value: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* noop */
  }
};

// 左滑超过这个距离触发关闭
const DISMISS_THRESHOLD = 64;

interface ChatSidebarProps {
  currentSessionId?: string;
}

export function ChatSidebar({ currentSessionId }: ChatSidebarProps) {
  const router = useRouter();
  const open = useUIStore((s) => s.sidebarOpen);
  const setOpen = useUIStore((s) => s.setSidebarOpen);
  const { data } = useSessionsQuery();
  const rawSessions = useMemo(() => data?.sessions ?? [], [data?.sessions]);

  const updateSession = useUpdateSessionMutation();
  const deleteSession = useDeleteSessionMutation();

  // 拆成「置顶」和「最近」两组,各组内按 last_message_at 倒序
  const { pinned, recent } = useMemo(() => {
    const sortByRecent = (a: { last_message_at: string }, b: { last_message_at: string }) =>
      +new Date(b.last_message_at) - +new Date(a.last_message_at);
    return {
      pinned: rawSessions.filter((s) => s.is_pinned).sort(sortByRecent),
      recent: rawSessions.filter((s) => !s.is_pinned).sort(sortByRecent),
    };
  }, [rawSessions]);

  // 折叠状态(localStorage 持久化)
  const [pinnedExpanded, setPinnedExpanded] = useState(() => readExpanded(PINNED_KEY));
  const [recentExpanded, setRecentExpanded] = useState(() => readExpanded(RECENT_KEY));
  const togglePinned = () => {
    setPinnedExpanded((v) => {
      writeExpanded(PINNED_KEY, !v);
      return !v;
    });
  };
  const toggleRecent = () => {
    setRecentExpanded((v) => {
      writeExpanded(RECENT_KEY, !v);
      return !v;
    });
  };

  // ── Menu / Rename 状态 ───────────────────────────────────
  const [menu, setMenu] = useState<{
    sessionId: string;
    anchor: { x: number; y: number };
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    sessionId: string;
    currentName: string;
  } | null>(null);

  const menuSession = menu ? rawSessions.find((s) => s.id === menu.sessionId) : null;

  const handleOpenMenu = useCallback((sessionId: string, anchor: { x: number; y: number }) => {
    setMenu({ sessionId, anchor });
  }, []);

  const handleTogglePin = () => {
    if (!menu || !menuSession) return;
    updateSession.mutate({
      sessionId: menu.sessionId,
      patch: { is_pinned: !menuSession.is_pinned },
    });
  };

  const handleRenameStart = () => {
    if (!menu || !menuSession) return;
    setRenameTarget({
      sessionId: menu.sessionId,
      currentName: menuSession.custom_name || menuSession.character_name,
    });
  };

  const handleRenameSubmit = (next: string) => {
    if (!renameTarget) return;
    updateSession.mutate({
      sessionId: renameTarget.sessionId,
      patch: { custom_name: next },
    });
    setRenameTarget(null);
  };

  const handleDelete = () => {
    if (!menu) return;
    const targetId = menu.sessionId;
    deleteSession.mutate({ sessionId: targetId });
    // 删除当前正在看的对话 → 退回大厅
    if (targetId === currentSessionId) {
      setOpen(false);
      router.push('/');
    }
  };

  const goSession = (id: string) => {
    setOpen(false);
    if (id !== currentSessionId) router.push(`/chat/${id}`);
  };

  // ── 动画状态 ──────────────────────────────────────────────
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 450);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── 拖拽状态（只追踪左滑，dragX ≤ 0）──────────────────────
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStart = useRef({ x: 0, y: 0 });

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0]!.clientX - touchStart.current.x;
    const dy = e.touches[0]!.clientY - touchStart.current.y;
    // 只处理「左滑为主方向」的手势
    if (dx < 0 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      setDragX(Math.min(0, dx)); // 不允许右滑超出原位置
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    if (Math.abs(dragX) > DISMISS_THRESHOLD) {
      setDragX(0);
      setOpen(false);
    } else {
      setDragX(0);
    }
  }, [dragX, setOpen]);

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="历史对话">
      {/* 右侧遮罩：点击 or 左滑都关闭。淡入比面板略慢,层次更明确 */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-500"
        style={{ opacity: visible ? 1 : 0 }}
        aria-hidden="true"
        onClick={() => setOpen(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* 侧边栏面板：从左侧滑入 */}
      <div
        className="absolute inset-y-0 left-0 flex w-[72vw] max-w-[280px] flex-col border-r border-border/60 bg-card shadow-2xl"
        style={{
          transform: visible ? `translateX(${dragX}px)` : 'translateX(-100%)',
          transition: isDragging ? 'none' : 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
          // pan-y:允许垂直滚动 native 行为(鼠标滚轮 / 触摸下滑),
          // 只禁用横向 native 行为(我们的左滑关闭由 touchMove 接管)
          touchAction: 'pan-y',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="mx-3 h-px bg-border/60"
          style={{ marginTop: 'calc(env(safe-area-inset-top) + 1rem)' }}
        />

        <nav
          aria-label="历史会话"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 py-2"
          // 恢复内容区纵向滚动
          style={{ touchAction: 'auto' }}
        >
          {pinned.length === 0 && recent.length === 0 ? (
            <p className="px-4 py-8 text-[13px] text-muted-foreground/80">还没有过对话。</p>
          ) : (
            <>
              {/* 置顶组始终显示,即使为空 — 作为发现性 hint,暗示存在置顶能力 */}
              <GroupHeader
                label="置顶"
                count={pinned.length}
                expanded={pinnedExpanded}
                onToggle={togglePinned}
              />
              {pinnedExpanded &&
                (pinned.length > 0 ? (
                  pinned.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === currentSessionId}
                      onSelect={goSession}
                      onOpenMenu={handleOpenMenu}
                    />
                  ))
                ) : (
                  <p className="px-3 py-2 text-[12px] text-muted-foreground/60">长按对话可置顶</p>
                ))}

              {recent.length > 0 && (
                <>
                  <GroupHeader
                    label="最近"
                    count={recent.length}
                    expanded={recentExpanded}
                    onToggle={toggleRecent}
                  />
                  {recentExpanded &&
                    recent.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        active={s.id === currentSessionId}
                        onSelect={goSession}
                        onOpenMenu={handleOpenMenu}
                      />
                    ))}
                </>
              )}
            </>
          )}
        </nav>
      </div>

      <SessionRowMenu
        anchor={menu?.anchor ?? null}
        isPinned={!!menuSession?.is_pinned}
        onClose={() => setMenu(null)}
        onTogglePin={handleTogglePin}
        onRename={handleRenameStart}
        onDelete={handleDelete}
      />

      <RenameDialog
        open={renameTarget !== null}
        initialValue={renameTarget?.currentName ?? ''}
        onClose={() => setRenameTarget(null)}
        onSubmit={handleRenameSubmit}
      />
    </div>,
    document.body
  );
}

interface GroupHeaderProps {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

function GroupHeader({ label, count, expanded, onToggle }: GroupHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="mt-2 flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/60 transition-colors hover:text-muted-foreground first:mt-0"
    >
      <ChevronDown className={cn('h-3 w-3 transition-transform', expanded ? '' : '-rotate-90')} />
      <span>{label}</span>
      <span className="ml-1 text-muted-foreground/40">{count}</span>
    </button>
  );
}
