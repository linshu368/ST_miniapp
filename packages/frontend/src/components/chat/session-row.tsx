'use client';

import type { SessionSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { formatWhisperTime } from '@/lib/utils/time';

interface SessionRowProps {
  session: SessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
}

export function SessionRow({ session, active, onSelect }: SessionRowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md px-3 py-3 text-left transition-colors',
        'hover:bg-secondary/60',
        active && 'bg-secondary/80'
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[14px] text-foreground">{session.character_name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/70">
          {formatWhisperTime(session.last_message_at)}
        </span>
      </div>
      <span className="truncate text-[12px] text-muted-foreground">
        {session.last_message_preview || '……'}
      </span>
    </button>
  );
}
