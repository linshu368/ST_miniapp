'use client';

import { useState } from 'react';
import type { CharacterSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { characterRoomGradient } from '@/lib/utils/character-hue';

interface CharacterCardProps {
  character: CharacterSummary;
  onSelect: (id: string) => void;
  disabled?: boolean;
  priority?: boolean;
  onImageSettled?: (id: string) => void;
}

export function lobbyImageUrl(source: string): string {
  try {
    const url = new URL(source);
    const marker = '/storage/v1/object/public/';
    if (!url.pathname.includes(marker)) return source;
    url.pathname = url.pathname.replace(marker, '/storage/v1/render/image/public/');
    url.searchParams.set('width', '360');
    url.searchParams.set('height', '480');
    url.searchParams.set('resize', 'cover');
    url.searchParams.set('quality', '68');
    return url.toString();
  } catch {
    return source;
  }
}

export function CharacterCard({
  character,
  onSelect,
  disabled,
  priority = false,
  onImageSettled,
}: CharacterCardProps) {
  const gradient = characterRoomGradient(character.id);
  const hasAvatar = !!character.avatar_url;
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(character.id)}
      className={cn(
        'group flex h-full w-full flex-col overflow-hidden rounded-[16px] border border-white/10 bg-white/5 text-left shadow-lg',
        'transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-2xl hover:shadow-indigo-500/20 hover:border-white/20 active:scale-95',
        'disabled:opacity-60'
      )}
      aria-label={`查看 ${character.name} 的详情`}
    >
      {/* 图片区：3:4 + 渐变叠层 + 名字 / 标签 */}
      <div className="relative aspect-[3/4] w-full shrink-0 overflow-hidden">
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            imageLoaded ? 'opacity-0' : 'opacity-100'
          }`}
          aria-hidden="true"
          style={{ background: gradient }}
        />
        {hasAvatar && !imageFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={lobbyImageUrl(character.avatar_url)}
            alt={character.name}
            width={360}
            height={480}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
            onLoad={() => {
              setImageLoaded(true);
              onImageSettled?.(character.id);
            }}
            onError={() => {
              setImageFailed(true);
              onImageSettled?.(character.id);
            }}
            className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-300 ${
              imageLoaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : null}

        {/* 渐变遮罩 */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/48 to-transparent"
        />

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
          <h3 className="line-clamp-2 px-0.5 text-[15px] font-semibold leading-tight text-white drop-shadow-sm sm:text-base">
            {character.name}
          </h3>

          {character.personality_tags.length > 0 && (
            <div className="flex max-h-[2.25rem] min-w-0 flex-wrap items-center gap-1 overflow-hidden">
              {character.personality_tags.slice(0, 6).map((t) => (
                <span
                  key={t}
                  className="max-w-[calc(50%-0.125rem)] truncate rounded-full bg-white/12 px-1.5 py-[3px] text-[10px] font-medium leading-none text-white/90 ring-1 ring-inset ring-white/15 backdrop-blur-[2px] sm:max-w-full"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 作者和原始描述暂不展示，避免未清洗字段影响大厅视觉。 */}
    </button>
  );
}
