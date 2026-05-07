'use client';

import { useRef } from 'react';
import { Bookmark } from 'lucide-react';
import type { SessionSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { formatWhisperTime } from '@/lib/utils/time';
import { hueShiftFromId } from '@/lib/utils/character-hue';
import { useCharacterQuery } from '@/lib/api/characters';

interface SessionRowProps {
  session: SessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onOpenMenu: (sessionId: string, anchor: { x: number; y: number }) => void;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8; // 抖动 < 8px 仍视为长按

export function SessionRow({ session, active, onSelect, onOpenMenu }: SessionRowProps) {
  const { data: charData } = useCharacterQuery(session.character_id);
  const avatarUrl = charData?.character?.avatar_url;
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    longPressFired.current = false;
    longPressStart.current = { x: e.clientX, y: e.clientY };
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      // 触发 haptic(若可用)
      try {
        const w = window as Window & {
          Telegram?: { WebApp?: { HapticFeedback?: { impactOccurred: (s: string) => void } } };
        };
        w.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
      } catch {
        /* noop */
      }
      const start = longPressStart.current;
      if (start) onOpenMenu(session.id, { x: start.x, y: start.y });
      longPressTimer.current = null;
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressStart.current;
    if (!start || longPressTimer.current === null) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(dy) > LONG_PRESS_MOVE_TOLERANCE) {
      clearLongPress();
    }
  };

  const handleClick = () => {
    if (longPressFired.current) return; // 长按触发了 menu,屏蔽 click 跳转
    onSelect(session.id);
  };

  const displayName = session.custom_name || session.character_name;
  const hue = hueShiftFromId(session.character_id);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(session.id);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      onContextMenu={(e) => {
        // 桌面端右键也走 menu
        e.preventDefault();
        onOpenMenu(session.id, { x: e.clientX, y: e.clientY });
      }}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left transition-colors',
        'hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-secondary/80'
      )}
    >
      {/* 头像 */}
      <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-lg ring-1 ring-inset ring-white/10">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background: `radial-gradient(100% 100% at 50% 30%, hsl(${hue} 60% 45%), hsl(${hue} 40% 18%))`,
            }}
            aria-hidden="true"
          />
        )}
      </div>

      {/* 文本两行 */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            {session.is_pinned && (
              <Bookmark
                className="h-3 w-3 shrink-0 fill-current text-muted-foreground/70"
                aria-label="已置顶"
              />
            )}
            <span className="truncate text-[14px] font-medium text-foreground">{displayName}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            {formatWhisperTime(session.last_message_at)}
          </span>
        </div>
        <span className="truncate text-[11px] text-muted-foreground/55">
          {session.last_message_preview || '……'}
        </span>
      </div>
    </div>
  );
}
