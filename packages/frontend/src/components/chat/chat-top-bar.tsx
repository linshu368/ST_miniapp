'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, PanelLeft, Settings2, Sparkles } from 'lucide-react';

import { FavoriteButton } from '@/components/characters/favorite-button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { ChatGenerationSettings } from './chat-generation-settings';
import { ChatModelSwitcher } from './chat-model-switcher';

type ToolsTab = 'model' | 'settings';

interface ChatTopBarProps {
  characterId: string;
  title: string;
  onOpenSessions: () => void;
  /** 充值页返回时要回到的地址，带上当前会话 */
  returnTo: string;
}

export function ChatTopBar({ characterId, title, onOpenSessions, returnTo }: ChatTopBarProps) {
  const router = useRouter();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tab, setTab] = useState<ToolsTab>('model');

  return (
    <>
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

        <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-1">
          <FavoriteButton characterId={characterId} variant="header" />
          <IconButton label="对话设置" onClick={() => setToolsOpen(true)}>
            <Settings2 className="size-[18px]" aria-hidden />
          </IconButton>
        </div>
      </header>

      <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[82vh] overflow-y-auto rounded-t-3xl border-border bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5"
        >
          <SheetTitle className="text-[16px] font-bold text-foreground">对话设置</SheetTitle>
          <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
            模型与生成偏好对你的所有角色生效
          </SheetDescription>

          <div className="my-4 flex gap-1 rounded-full bg-muted p-1">
            <TabButton active={tab === 'model'} onClick={() => setTab('model')}>
              <Sparkles className="mr-1.5 inline size-3.5" aria-hidden />
              剧情引擎
            </TabButton>
            <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
              生成偏好
            </TabButton>
          </div>

          {tab === 'model' ? <ChatModelSwitcher returnTo={returnTo} /> : <ChatGenerationSettings />}
        </SheetContent>
      </Sheet>
    </>
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-full py-2 text-[13px] font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
      )}
    >
      {children}
    </button>
  );
}
