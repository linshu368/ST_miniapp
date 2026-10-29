'use client';

import { memo, useState } from 'react';
import type { CharacterSummary } from '@miniapp/shared';
import { Flame } from 'lucide-react';

import { cn } from '@/lib/utils';
import { characterRoomGradient } from '@/lib/utils/character-hue';

import { CharacterSocialBar } from './character-social-bar';
import { FeaturedFrame } from './featured-frame';

interface CharacterCardProps {
  character: CharacterSummary;
  onSelect: (id: string) => void;
  onComments: (id: string) => void;
  disabled?: boolean;
  priority?: boolean;
  experienced?: boolean;
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

// memo：打开详情弹层只改 previewId，不该连带重渲染整页卡片（调用方保证 onSelect 引用稳定）。
export const CharacterCard = memo(function CharacterCard({
  character,
  onSelect,
  onComments,
  disabled,
  priority = false,
  experienced = false,
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
        'group flex w-full flex-col overflow-hidden rounded-t-[16px] bg-card text-left',
        'transition-opacity duration-150 active:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary motion-reduce:transition-none',
        'disabled:opacity-60'
      )}
      aria-label={`查看 ${character.name} 的详情`}
    >
      {/* 图片区：3:4 + 渐变叠层 + 名字 / 标签 */}
      <div className="relative aspect-[3/4] w-full shrink-0 overflow-hidden">
        {experienced ? (
          <span className="absolute left-2 top-2 z-20 rounded-full border border-white/15 bg-black/45 px-2 py-1 text-[10px] font-medium leading-none text-white/90 backdrop-blur-sm">
            聊过
          </span>
        ) : null}
        {character.is_featured && (
          <span
            className="absolute right-2 top-2 z-20 flex size-8 items-center justify-center rounded-full border border-primary/70 bg-black/65 shadow-[0_0_18px_hsl(var(--glow)/0.65)]"
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
            // 从会话/详情返回时卡片重挂，图片多半已在内存缓存里：commit 阶段发现已解码完成就直接
            // 显示，避免“渐变占位 → 300ms 淡入”再闪一次（此处 setState 会在首次绘制前同步重渲染）。
            ref={(node) => {
              if (node && node.complete && node.naturalWidth > 0) setImageLoaded(true);
            }}
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

        {/* 图内只放角色信息，轻量互动栏单独承接在封面下沿。 */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
          <h3 className="line-clamp-2 px-0.5 text-[15px] font-semibold leading-tight text-white drop-shadow-sm sm:text-base">
            {character.name}
          </h3>

          {character.personality_tags.length > 0 && (
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
              {character.personality_tags.slice(0, 2).map((t) => (
                <span
                  key={t}
                  className="max-w-[calc(50%-0.125rem)] truncate rounded-full bg-white/[0.08] px-1.5 py-[3px] text-[10px] font-medium leading-none text-white/75 ring-1 ring-inset ring-white/10"
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

  const card = (
    <div className="relative h-full overflow-hidden rounded-[16px] border border-border bg-card shadow-lg">
      {cardButton}
      <div className="border-t border-white/[0.04] bg-card">
        <CharacterSocialBar
          characterId={character.id}
          name={character.name}
          onComments={() => onComments(character.id)}
          compact
        />
      </div>
    </div>
  );

  return (
    <div className="h-full" data-lobby-character-id={character.id}>
      <FeaturedFrame featured={character.is_featured} className="h-full rounded-[18px]">
        {card}
      </FeaturedFrame>
    </div>
  );
});
