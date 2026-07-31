'use client';

import { useState } from 'react';
import type { CharacterSummary } from '@miniapp/shared';
import { Flame } from 'lucide-react';

import { cn } from '@/lib/utils';
import { characterRoomGradient } from '@/lib/utils/character-hue';

import { FavoriteButton } from './favorite-button';

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

  const cardButton = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(character.id)}
      className={cn(
        'group flex h-full w-full flex-col overflow-hidden rounded-[16px] border border-border bg-card text-left shadow-lg',
        'transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-2xl hover:shadow-[0_18px_40px_hsl(var(--glow)/0.2)] hover:border-primary/30 active:scale-95',
        'disabled:opacity-60'
      )}
      aria-label={`查看 ${character.name} 的详情`}
    >
      {/* 图片区：3:4 + 渐变叠层 + 名字 / 标签 */}
      <div className="relative aspect-[3/4] w-full shrink-0 overflow-hidden">
        {character.is_featured && (
          <span
            className="absolute right-2 top-2 z-20 flex size-8 items-center justify-center rounded-full border border-primary/70 bg-black/55 shadow-[0_0_18px_hsl(var(--glow)/0.65)] backdrop-blur-sm"
            title="热门角色"
            aria-label="热门角色"
          >
            <Flame className="size-[18px] fill-primary/80 text-primary" aria-hidden="true" />
          </span>
        )}
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

        {/* 右侧留出心形按钮的位置，名称与标签不被遮挡。 */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2.5 pb-2.5 pr-12 sm:px-3 sm:pb-3 sm:pr-[3.25rem]">
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

  // 心形与卡片是兄弟节点：button 不能嵌套 button，同时天然避免点心形误触进入角色。
  const card = (
    <div className="relative h-full">
      {cardButton}
      <FavoriteButton
        characterId={character.id}
        variant="card"
        className="absolute bottom-2.5 right-2.5 z-20 sm:bottom-3 sm:right-3"
      />
    </div>
  );

  if (!character.is_featured) return card;

  return <div className="featured-character-frame h-full rounded-[18px] p-[2px]">{card}</div>;
}
