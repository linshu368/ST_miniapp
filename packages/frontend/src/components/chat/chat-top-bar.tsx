'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronLeft, PanelLeft } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

import { FavoriteButton } from '@/components/characters/favorite-button';
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
  const selectedId = catalog.data?.selected_model_id ?? catalog.data?.catalog.default_model_id;
  const selectedTier = catalog.data?.catalog.tiers.find((tier) =>
    tier.models.some((model) => model.id === selectedId)
  );
  const engineLabels: Record<string, string> = {
    light: '轻量引擎',
    standard: '标准引擎',
    premium: '旗舰引擎',
  };
  const modelLabel = selectedTier ? (engineLabels[selectedTier.key] ?? '选择引擎') : '选择引擎';

  return (
    <DialogPrimitive.Root open={modelOpen} onOpenChange={setModelOpen} modal={false}>
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
            <DialogPrimitive.Trigger asChild>
              <button
                type="button"
                aria-label={`当前${modelLabel}，${modelOpen ? '收起' : '展开'}引擎选择`}
                className="mt-1 inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-primary/70 bg-primary/10 px-3 text-[11px] font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  className="size-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                  aria-hidden
                />
                <span className="truncate">{modelLabel}</span>
                <ChevronDown
                  className={cn(
                    'size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
                    modelOpen && 'rotate-180'
                  )}
                  aria-hidden
                />
              </button>
            </DialogPrimitive.Trigger>
          </div>

          <div className="flex shrink-0 items-center pr-1">
            <FavoriteButton characterId={characterId} variant="header" />
          </div>
        </div>

        {/* 非模态 Radix 面板保留 Esc、焦点恢复与外部点击关闭，位置随 sticky 顶栏移动。 */}
        <DialogPrimitive.Content
          className="chat-scroll-area absolute inset-x-2 top-full mt-2 max-h-[min(70dvh,36rem)] overflow-y-auto overscroll-contain rounded-3xl border border-primary/25 bg-background p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 duration-150 motion-reduce:animate-none motion-reduce:transition-none sm:inset-x-0 sm:mx-auto sm:max-w-md"
          onInteractOutside={(event) => {
            // VIP 说明使用 Portal；在其内部交互不应卸载承载该弹窗的引擎面板。
            if (
              event.target instanceof Element &&
              event.target.closest('[data-model-vip-dialog]')
            ) {
              event.preventDefault();
            }
          }}
        >
          <DialogPrimitive.Title className="text-[16px] font-bold text-foreground">
            引擎选择
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-0.5 text-[12px] text-muted-foreground">
            选择驱动对话的引擎与模型
          </DialogPrimitive.Description>
          <div className="mt-4">
            <ChatModelSwitcher
              returnTo={returnTo}
              generating={generating}
              freeRoundActive={freeRoundActive}
              onSwitched={() => setModelOpen(false)}
            />
          </div>
        </DialogPrimitive.Content>
      </header>
    </DialogPrimitive.Root>
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
