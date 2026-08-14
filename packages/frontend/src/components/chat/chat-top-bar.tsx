'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, PanelLeft } from 'lucide-react';

import { FavoriteButton } from '@/components/characters/favorite-button';
import { cn } from '@/lib/utils';

interface ChatTopBarProps {
  characterId: string;
  title: string;
  onOpenSessions: () => void;
}

/**
 * 几何对齐原版 ST 链路的顶栏（components/tavern/chat-header.tsx）：
 * 安全区 + 56px 总高、返回键 40px、标题绝对居中 46% 截断、右侧只有收藏。
 * 原版用 fixed + 固定高度 + items-end 实现，这里用 sticky + 上下 8px 内边距，
 * 算下来是同一批像素；不跟着换 fixed 是因为键盘弹起时整页要跟 visualViewport 缩，
 * fixed 会脱离那个容器、重新被 iOS 推出屏幕。
 *
 * 侧边栏入口保留 PanelLeft 与「对话记录」，不还原成原版的 MessagesSquare 与
 * 「历史对话」：原版那个抽屉列的是所有角色的聊天，这里列的是当前角色的会话，
 * 沿用原文案会指向另一个东西。图标尺寸与配色仍按原版取值。
 */
export function ChatTopBar({ characterId, title, onOpenSessions }: ChatTopBarProps) {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-20 flex items-center gap-0.5 border-b border-border/60 bg-background/95 px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] shadow-[0_1px_12px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      <IconButton label="返回大厅" onClick={() => router.push('/')}>
        <ChevronLeft className="size-5" strokeWidth={2.2} aria-hidden />
      </IconButton>
      <IconButton label="对话记录" onClick={onOpenSessions} muted>
        <PanelLeft className="size-[19px]" strokeWidth={2} aria-hidden />
      </IconButton>

      <span className="pointer-events-none absolute left-1/2 max-w-[46%] -translate-x-1/2 truncate text-[16px] font-semibold tracking-tight text-foreground">
        {title}
      </span>

      <div className="ml-auto flex shrink-0 items-center pr-1">
        <FavoriteButton characterId={characterId} variant="header" />
      </div>
    </header>
  );
}

function IconButton({
  label,
  onClick,
  muted,
  children,
}: {
  label: string;
  onClick: () => void;
  /** 原版把侧边栏入口压得比返回键淡一档 */
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted active:scale-95',
        muted ? 'text-muted-foreground hover:text-foreground' : 'text-foreground'
      )}
    >
      {children}
    </button>
  );
}
