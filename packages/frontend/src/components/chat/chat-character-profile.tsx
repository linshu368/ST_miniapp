'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import type { CharacterDetail } from '@miniapp/shared';

import { hueShiftFromId } from '@/lib/utils/character-hue';
import { cn } from '@/lib/utils';

interface ChatCharacterProfileProps {
  character: CharacterDetail | null | undefined;
  isLoading?: boolean;
  className?: string;
}

export function ChatCharacterProfile({
  character,
  isLoading,
  className,
}: ChatCharacterProfileProps) {
  const [introOpen, setIntroOpen] = useState(false);
  const introBodyId = useId();

  if (isLoading) {
    return (
      <div className={cn('flex flex-col items-center px-6 pt-6 pb-4', className)} aria-busy="true">
        <div className="mb-6 flex justify-center">
          <div className="h-[96px] w-[96px] animate-pulse rounded-full bg-muted/60 ring-2 ring-border" />
        </div>
        <div className="mb-8 h-7 w-48 animate-pulse rounded-md bg-muted/60" />
        <div className="w-full rounded-2xl border border-border bg-card/40 p-5">
          <div className="mx-auto mb-3 h-4 w-10 animate-pulse rounded bg-muted/50" />
          <div className="mb-3 min-h-[3.5rem] space-y-2">
            <div className="h-3.5 w-full animate-pulse rounded bg-muted/40" />
            <div className="h-3.5 w-[92%] animate-pulse rounded bg-muted/40" />
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted/40" />
          </div>
          <div className="flex justify-end">
            <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted/40" />
          </div>
        </div>
      </div>
    );
  }

  if (!character) {
    return null;
  }

  const body = (character.description ?? '').trim() || '暂无简介。';
  const fallbackHue = hueShiftFromId(character.id);

  return (
    <div className={cn('flex flex-col items-center px-6 pt-6 pb-4', className)}>
      <div className="mb-6 flex justify-center">
        <div
          className="relative h-[96px] w-[96px] shrink-0 overflow-hidden rounded-full ring-2 ring-border"
          style={{
            boxShadow: '0 0 24px rgba(255,255,255,0.08)',
          }}
        >
          {character.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={character.avatar_url}
              alt={character.name}
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div
              className="h-full w-full"
              style={{
                background: `radial-gradient(100% 100% at 50% 30%, hsl(${fallbackHue} 60% 42%), hsl(${fallbackHue} 40% 14%))`,
              }}
            />
          )}
        </div>
      </div>

      <h2 className="mb-5 max-w-full text-balance px-2 text-center text-[20px] font-medium leading-relaxed text-white">
        {character.name}
      </h2>

      <div className="mx-4 mb-6 w-full rounded-2xl border border-white/10 bg-white/[0.06] p-5">
        <div className="text-center">
          <span className="text-sm font-medium tracking-wide text-white/80">简介</span>
        </div>
        <p
          id={introBodyId}
          className={cn(
            'mt-2.5 min-w-0 text-left text-sm font-normal leading-loose text-[rgba(255,255,255,0.75)]',
            !introOpen && 'line-clamp-3'
          )}
        >
          {body}
        </p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            aria-expanded={introOpen}
            aria-controls={introBodyId}
            onClick={() => setIntroOpen((v) => !v)}
            className="flex items-center gap-1 rounded-md py-1 pl-2 pr-1 text-sm font-normal text-white/60 outline-none transition-colors hover:text-white/80 focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-0"
          >
            {introOpen ? '收起' : '展开'}
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 transition-transform duration-200',
                introOpen && 'rotate-180'
              )}
              strokeWidth={2}
              aria-hidden
            />
          </button>
        </div>
      </div>
    </div>
  );
}
