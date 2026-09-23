'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, PanelLeft } from 'lucide-react';

import { FavoriteButton } from '@/components/characters/favorite-button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useModelCatalogQuery } from '@/lib/api/models';
import { cn } from '@/lib/utils';

import { ChatModelSwitcher } from './chat-model-switcher';

interface ChatTopBarProps {
  characterId: string;
  title: string;
  onOpenSessions: () => void;
  returnTo: string;
  generating: boolean;
  freeRoundActive: boolean;
}

/**
 * 顶栏在角色名下方居中放当前模型胶囊。
 * 仍然用 sticky：键盘弹起时整页跟着 visualViewport 缩，fixed 会脱离那个容器。
 */
export function ChatTopBar({
  characterId,
  title,
  onOpenSessions,
  returnTo,
  generating,
  freeRoundActive,
}: ChatTopBarProps) {
  const router = useRouter();
  const [modelOpen, setModelOpen] = useState(false);
  const catalog = useModelCatalogQuery();
  const selectedName = catalog.data?.catalog.tiers
    .flatMap((tier) => tier.models)
    .find((model) => model.id === catalog.data?.selected_model_id)?.display_name;
  const modelLabel = selectedName ?? '选择模型';

  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] shadow-[0_1px_12px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1">
        <div className="flex items-center">
          <IconButton label="返回大厅" onClick={() => router.push('/')}>
            <ChevronLeft className="size-5" strokeWidth={2.2} aria-hidden />
          </IconButton>
          <IconButton label="对话记录" onClick={onOpenSessions} muted>
            <PanelLeft className="size-[19px]" strokeWidth={2} aria-hidden />
          </IconButton>
        </div>

        <div className="flex min-w-0 flex-col items-center">
          <span className="max-w-full truncate text-center text-[16px] font-semibold tracking-tight text-foreground">
            {title}
          </span>
          <button
            type="button"
            onClick={() => setModelOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={modelOpen}
            aria-label={`当前模型 ${modelLabel}，点击更换`}
            className="mt-1 max-w-full truncate rounded-full border border-primary/70 bg-primary/10 px-3 py-0.5 text-[11px] font-semibold text-primary"
          >
            {modelLabel}
          </button>
        </div>

        <div className="flex shrink-0 items-center pr-1">
          <FavoriteButton characterId={characterId} variant="header" />
        </div>
      </div>

      <Sheet open={modelOpen} onOpenChange={setModelOpen}>
        <SheetContent
          side="bottom"
          className="chat-scroll-area max-h-[82vh] overflow-y-auto rounded-t-3xl border-border bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5"
        >
          <SheetTitle className="text-[16px] font-bold text-foreground">模型选择</SheetTitle>
          <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
            选择驱动对话的模型
          </SheetDescription>
          <div className="mt-4">
            <ChatModelSwitcher
              returnTo={returnTo}
              generating={generating}
              freeRoundActive={freeRoundActive}
              onSwitched={() => setModelOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>
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
