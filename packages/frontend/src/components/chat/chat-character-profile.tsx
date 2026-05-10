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
      <div className={cn('flex flex-col items-center', className)} aria-busy="true">
        <div className="py-8 pb-10">
          <div className="mx-auto h-[140px] w-[140px] animate-pulse rounded-full bg-white/[0.06] ring-2 ring-white/[0.08]" />
        </div>
        <div className="h-9 w-48 animate-pulse rounded-md bg-white/[0.06]" />
        <div className="mb-8 mt-0 w-[calc(100%-40px)] rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4">
          <div className="flex gap-2.5">
            <div className="h-4 w-10 shrink-0 animate-pulse rounded bg-white/[0.08]" />
            <div className="min-h-[3.5rem] flex-1 space-y-2">
              <div className="h-3 w-full animate-pulse rounded bg-white/[0.06]" />
              <div className="h-3 w-[92%] animate-pulse rounded bg-white/[0.06]" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-white/[0.06]" />
            </div>
            <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-white/[0.05]" />
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
    <div className={cn('flex flex-col items-center', className)}>
      {/* 头像：140×140 + 规范边框 / 光晕 */}
      <div className="flex justify-center py-8 pb-10">
        <div
          className="relative h-[140px] w-[140px] shrink-0 overflow-hidden rounded-full"
          style={{
            border: '2px solid rgba(255,255,255,0.14)',
            boxShadow: '0 0 40px rgba(96,135,195,0.25)',
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

      {/* 角色标题 */}
      <h2 className="px-8 pb-10 text-center text-[30px] font-semibold leading-[1.4] tracking-[0.01em] text-[#F2F3F5]">
        {character.name}
      </h2>

      {/* 简介卡片：横向 flex + 右侧折叠箭头 */}
      <div className="mx-5 mb-8 flex items-start gap-2.5 rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-4 py-3.5">
        <span
          className="shrink-0 text-[13px] font-semibold text-[#F2F3F5]"
          style={{ letterSpacing: '0.06em' }}
        >
          简介
        </span>
        <p
          id={introBodyId}
          className={cn(
            'min-w-0 flex-1 text-left text-[12.5px] leading-[1.7] text-[rgba(242,243,245,0.78)]',
            !introOpen && 'line-clamp-3'
          )}
        >
          {body}
        </p>
        <button
          type="button"
          aria-expanded={introOpen}
          aria-controls={introBodyId}
          onClick={() => setIntroOpen((v) => !v)}
          className="shrink-0 self-start pt-0.5 text-[rgba(242,243,245,0.55)] outline-none transition-transform duration-200 ease-out hover:text-[rgba(242,243,245,0.75)] focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0D11]"
          aria-label={introOpen ? '收起简介' : '展开简介'}
        >
          <ChevronDown
            className={cn('h-5 w-5 transition-transform duration-200', introOpen && 'rotate-180')}
            strokeWidth={2}
          />
        </button>
      </div>
    </div>
  );
}
