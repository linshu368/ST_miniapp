'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';

import { useSessionsQuery } from '@/lib/api/chat';
import { useUIStore } from '@/stores/ui-store';

import { SessionRow } from './session-row';

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
  const sessions = data?.sessions ?? [];

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
      const t = setTimeout(() => setMounted(false), 320);
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
      {/* 右侧遮罩：点击 or 左滑都关闭 */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
        aria-hidden="true"
        onClick={() => setOpen(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* 侧边栏面板：从左侧滑入 */}
      <div
        className="absolute inset-y-0 left-0 flex w-[72vw] max-w-[280px] flex-col border-r border-border/60 bg-card"
        style={{
          transform: visible ? `translateX(${dragX}px)` : 'translateX(-100%)',
          transition: isDragging ? 'none' : 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
          touchAction: 'none',
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
          {sessions.length === 0 ? (
            <p className="px-4 py-8 text-[13px] text-muted-foreground/80">还没有过对话。</p>
          ) : (
            sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSessionId}
                onSelect={goSession}
              />
            ))
          )}
        </nav>
      </div>
    </div>,
    document.body
  );
}
