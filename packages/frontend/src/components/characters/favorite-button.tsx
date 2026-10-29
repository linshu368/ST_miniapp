'use client';

import { Star } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useFavoriteToggle } from '@/lib/api/favorites';

type FavoriteButtonVariant = 'card' | 'sheet' | 'header' | 'social';

interface FavoriteButtonProps {
  characterId: string | null | undefined;
  variant?: FavoriteButtonVariant;
  className?: string;
  count?: number;
  showZeroLabel?: boolean;
}

const CONTAINER_STYLES: Record<FavoriteButtonVariant, string> = {
  card: 'h-11 w-11 rounded-full bg-black/60 ring-1 ring-inset ring-white/15 hover:bg-black/75',
  sheet: 'h-12 w-12 rounded-2xl border border-border bg-card hover:bg-secondary',
  header: 'h-11 w-11 rounded-full hover:bg-secondary',
  social: 'min-h-11 min-w-0 gap-1.5 rounded-xl px-1',
};

const ICON_STYLES: Record<FavoriteButtonVariant, string> = {
  card: 'h-[18px] w-[18px]',
  sheet: 'h-5 w-5',
  header: 'h-5 w-5',
  social: 'h-4 w-4',
};

/**
 * 角色卡收藏按钮。首页卡面、详情弹层和对话页顶栏共用，
 * 收藏状态统一来自 useFavoriteToggle，任一处切换其余入口同步。
 */
export function FavoriteButton({
  characterId,
  variant = 'card',
  className,
  count,
  showZeroLabel = true,
}: FavoriteButtonProps) {
  const { favorited, pending, error, toggle } = useFavoriteToggle(characterId);

  return (
    <button
      type="button"
      disabled={!characterId || pending}
      aria-busy={pending}
      aria-describedby={error ? 'favorite-feedback-notice' : undefined}
      aria-label={favorited ? '取消收藏' : '收藏角色卡'}
      aria-pressed={favorited}
      // 收藏和进入角色是独立动作，触区相邻时也不能顺带打开详情。
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }}
      className={cn(
        'flex shrink-0 items-center justify-center transition-all active:scale-95 disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        favorited ? 'text-[#d7b68d]' : 'text-muted-foreground',
        CONTAINER_STYLES[variant],
        className
      )}
    >
      <Star
        className={cn(
          ICON_STYLES[variant],
          'transition-all duration-200',
          favorited && 'fill-current',
          // 请求在途时轻微收缩，给出“已受理”的即时反馈。
          pending && 'scale-90'
        )}
      />
      {variant === 'social' && (count !== 0 || showZeroLabel) ? (
        <span className="truncate tabular-nums">
          {count === undefined
            ? '—'
            : count === 0
              ? '收藏'
              : count >= 10_000
                ? `${(count / 10_000).toFixed(1).replace(/\.0$/, '')}万`
                : count}
        </span>
      ) : null}
    </button>
  );
}
