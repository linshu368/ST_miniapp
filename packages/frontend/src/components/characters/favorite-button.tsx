'use client';

import { Heart } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useFavoriteToggle } from '@/lib/api/favorites';

type FavoriteButtonVariant = 'card' | 'sheet' | 'header';

interface FavoriteButtonProps {
  characterId: string | null | undefined;
  variant?: FavoriteButtonVariant;
  className?: string;
}

const CONTAINER_STYLES: Record<FavoriteButtonVariant, string> = {
  // 大厅卡面右下角：半透明底 + 模糊，压在渐变遮罩之上仍然可辨。
  // 卡面变体压在角色图上，底色保持中性黑罩：图片颜色不可控，套主题色反而会脏。
  card: 'h-9 w-9 rounded-full bg-black/45 backdrop-blur-md ring-1 ring-inset ring-white/15 hover:bg-black/60',
  sheet: 'h-12 w-12 rounded-2xl border border-border bg-card hover:bg-secondary',
  header: 'h-9 w-9 rounded-full hover:bg-secondary',
};

const ICON_STYLES: Record<FavoriteButtonVariant, string> = {
  card: 'h-[18px] w-[18px]',
  sheet: 'h-5 w-5',
  header: 'h-5 w-5',
};

/**
 * 角色卡收藏按钮。首页卡面、详情弹层和对话页顶栏共用，
 * 收藏状态统一来自 useFavoriteToggle，任一处切换其余入口同步。
 */
export function FavoriteButton({ characterId, variant = 'card', className }: FavoriteButtonProps) {
  const { favorited, pending, toggle } = useFavoriteToggle(characterId);

  return (
    <button
      type="button"
      disabled={!characterId}
      aria-label={favorited ? '取消收藏' : '收藏角色卡'}
      aria-pressed={favorited}
      // 卡面上心形与卡片进入动作相邻，必须吃掉事件避免顺带进入角色。
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }}
      className={cn(
        'flex shrink-0 items-center justify-center transition-all active:scale-90 disabled:opacity-50',
        CONTAINER_STYLES[variant],
        className
      )}
    >
      <Heart
        className={cn(
          ICON_STYLES[variant],
          'transition-all duration-200',
          favorited ? 'fill-rose-fill text-rose' : 'text-foreground/75',
          // 请求在途时轻微收缩，给出“已受理”的即时反馈。
          pending && 'scale-90'
        )}
      />
    </button>
  );
}
