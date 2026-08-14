'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, PanelLeft } from 'lucide-react';

import { FavoriteButton } from '@/components/characters/favorite-button';

interface ChatTopBarProps {
  characterId: string;
  title: string;
  onOpenSessions: () => void;
}

/**
 * 顶栏右侧只留收藏。模型与生成偏好都收进了输入框左下角的工具箱，
 * 顶栏再放一个设置入口会出现两个都能改模型的地方。
 */
export function ChatTopBar({ characterId, title, onOpenSessions }: ChatTopBarProps) {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-20 flex items-center gap-0.5 border-b border-border/60 bg-background/95 px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl">
      <IconButton label="返回大厅" onClick={() => router.push('/')}>
        <ChevronLeft className="size-5" strokeWidth={2.2} aria-hidden />
      </IconButton>
      <IconButton label="对话记录" onClick={onOpenSessions}>
        <PanelLeft className="size-[18px]" aria-hidden />
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
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-10 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-95"
    >
      {children}
    </button>
  );
}
