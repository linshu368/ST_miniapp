'use client';

import { Heart, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCharacterLikeToggle, useCharacterSocialQuery } from '@/lib/api/character-social';
import { FavoriteButton } from './favorite-button';

export function socialCount(value: number | undefined, empty: string): string {
  if (value === undefined) return '—';
  if (value === 0) return empty;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}

interface Props {
  characterId: string;
  name: string;
  onComments: () => void;
  compact?: boolean;
}

/** 卡片只订阅批量预热的缓存；不能每张卡各发一笔计数请求。 */
export function CharacterSocialBar({ characterId, name, onComments, compact = false }: Props) {
  const social = useCharacterSocialQuery(characterId, false);
  const like = useCharacterLikeToggle(characterId);
  const cell = cn(
    'flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-1 transition-colors active:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45',
    compact ? 'gap-1 px-0 text-[11px] [&>span]:text-muted-foreground/70' : 'text-xs'
  );
  return (
    <div>
      <div
        role="group"
        aria-label={`${name}的互动`}
        className={cn('grid grid-cols-3 items-center', compact ? '' : 'gap-1')}
      >
        <button
          type="button"
          aria-label={`${like.liked ? '取消点赞' : '点赞'} ${name}`}
          aria-pressed={like.liked}
          aria-busy={like.pending}
          disabled={like.pending || !social.data}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            like.toggle();
          }}
          className={cn(cell, like.liked ? 'text-[#d9a3ad]' : 'text-muted-foreground')}
        >
          <Heart
            aria-hidden
            className={cn(
              'size-4 shrink-0 transition-transform motion-reduce:transition-none',
              like.liked && 'fill-current',
              like.pending && 'scale-90'
            )}
            strokeWidth={1.65}
          />
          {!compact || social.data?.like_count !== 0 ? (
            <span className="truncate tabular-nums">
              {socialCount(social.data?.like_count, '点赞')}
            </span>
          ) : null}
        </button>
        <FavoriteButton
          characterId={characterId}
          variant="social"
          count={social.data?.favorite_count}
          showZeroLabel={!compact}
          className={cell}
        />
        <button
          type="button"
          aria-label={`查看 ${name} 的评论`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onComments();
          }}
          className={cn(cell, 'text-muted-foreground')}
        >
          <MessageCircle className="size-4 shrink-0" strokeWidth={1.65} aria-hidden />
          {!compact || social.data?.comment_count !== 0 ? (
            <span className="truncate tabular-nums">
              {socialCount(social.data?.comment_count, '评论')}
            </span>
          ) : null}
        </button>
      </div>
      {like.error ? (
        <p role="alert" className="px-2 pb-2 text-center text-[11px] leading-4 text-[#d9a3ad]">
          {like.error}
        </p>
      ) : null}
    </div>
  );
}
