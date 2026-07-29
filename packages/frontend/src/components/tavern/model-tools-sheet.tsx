'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  // Image,
  MessageSquarePlus,
  // Mic,
  Sparkles,
  WandSparkles,
  // UserRound,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useModelCatalogQuery } from '@/lib/api/models';
import { shouldRefreshModelCatalog } from '@/lib/api/model-cache-policy';
import { platformAction, useBridgeStatus } from '@/lib/bridge';
import { ModelTierSwitcher } from './model-tier-switcher';

type MenuState = 'closed' | 'tools' | 'models';
const DISMISS_THRESHOLD_Y = 80;

export function ModelToolsSheet() {
  const [menuState, setMenuState] = useState<MenuState>('closed');
  const bridgeReady = useBridgeStatus() === 'ready';
  const catalogQuery = useModelCatalogQuery();
  const { dataUpdatedAt, refetch } = catalogQuery;
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchStartY = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menuState === 'models' && shouldRefreshModelCatalog(dataUpdatedAt)) {
      void refetch();
    }
  }, [dataUpdatedAt, menuState, refetch]);

  const close = useCallback(() => {
    setDragY(0);
    setMenuState('closed');
  }, []);

  const handleTouchStart = useCallback((event: React.TouchEvent) => {
    touchStartY.current = event.touches[0]?.clientY ?? 0;
    setDragging(true);
  }, []);

  const handleTouchMove = useCallback((event: React.TouchEvent) => {
    const delta = (event.touches[0]?.clientY ?? 0) - touchStartY.current;
    if (delta > 0 && (scrollRef.current?.scrollTop ?? 0) === 0) setDragY(delta);
  }, []);

  const handleTouchEnd = useCallback(() => {
    setDragging(false);
    if (dragY > DISMISS_THRESHOLD_Y) close();
    else setDragY(0);
  }, [close, dragY]);

  const currentModel = catalogQuery.data?.catalog.tiers
    .flatMap((tier) => tier.models)
    .find((model) => model.id === catalogQuery.data?.selected_model_id);

  async function handleNewChat() {
    if (!bridgeReady) return;
    try {
      await platformAction('newChat', {});
    } catch (error) {
      console.error('[ModelToolsSheet] newChat failed:', error);
    }
  }

  return (
    <>
      <button
        onClick={() => setMenuState((state) => (state === 'closed' ? 'tools' : 'closed'))}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+13px)] left-[13px] z-20 flex size-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition hover:bg-muted active:scale-95"
        aria-label="工具菜单"
      >
        <WandSparkles className="size-[18px]" strokeWidth={2} />
      </button>

      {menuState !== 'closed' && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
              <button
                type="button"
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={close}
                aria-label="关闭工具面板"
              />
              <div
                className="absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-[480px] flex-col overflow-hidden rounded-t-[28px] border border-border bg-popover/[0.98] text-popover-foreground shadow-[0_-24px_80px_rgba(0,0,0,0.25)]"
                style={{
                  height: menuState === 'models' ? '75dvh' : '50dvh',
                  transform: `translateY(${dragY}px)`,
                  transition: dragging
                    ? 'none'
                    : 'height 220ms ease, transform 320ms cubic-bezier(0.32,0.72,0,1)',
                }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                <div className="flex shrink-0 justify-center pb-2 pt-2.5">
                  <div className="h-1 w-10 rounded-full bg-muted-foreground/35" />
                </div>
                <div
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto"
                  style={{ touchAction: 'pan-y' }}
                >
                  {menuState === 'tools' ? (
                    <ToolsPanel
                      currentModelName={currentModel?.display_name ?? '加载中'}
                      bridgeReady={bridgeReady}
                      onModels={() => setMenuState('models')}
                      onNewChat={() => {
                        void handleNewChat();
                        close();
                      }}
                    />
                  ) : (
                    <ModelTierSwitcher onBack={() => setMenuState('tools')} onClose={close} />
                  )}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function ToolsPanel(props: {
  currentModelName: string;
  bridgeReady: boolean;
  onModels: () => void;
  onNewChat: () => void;
}) {
  /*
   * 暂时隐藏以下三个未开放工具，保留代码供后续重新启用。
  const disabledTools = [
    { label: '角色人设', subtitle: '自定义性格与风格', icon: UserRound, color: '#c084fc' },
    { label: '场景插画', subtitle: 'AI 绘图生成', icon: Image, color: '#4ade80' },
    { label: '角色配音', subtitle: '语音输入与朗读', icon: Mic, color: '#fbbf24' },
  ];
  */

  return (
    <div className="px-4 pb-8">
      <div className="mb-4 px-1">
        <h2 className="text-lg font-semibold text-foreground">工具箱</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">调整当前对话体验</p>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <button
          type="button"
          onClick={props.onModels}
          className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-secondary"
        >
          <ToolIcon icon={Sparkles} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">模型选择</p>
            <p className="text-[11px] text-muted-foreground">切换对话模型</p>
          </div>
          <span className="max-w-[38%] truncate text-xs text-muted-foreground">
            {props.currentModelName}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        {/* 暂时隐藏，后续开放时恢复 disabledTools 定义及以下渲染代码。
        {disabledTools.map((tool) => (
          <div
            key={tool.label}
            className="ml-[60px] flex items-center border-t border-white/[0.07] py-4 pr-4 opacity-45"
          >
            <div className="-ml-[44px] mr-3">
              <ToolIcon icon={tool.icon} color={tool.color} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-white">{tool.label}</p>
              <p className="text-[11px] text-white/40">{tool.subtitle}</p>
            </div>
            <span className="text-[10px] text-white/30">即将开放</span>
          </div>
        ))}
        */}
      </div>
      <button
        type="button"
        disabled={!props.bridgeReady}
        onClick={props.onNewChat}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground disabled:opacity-40"
      >
        <MessageSquarePlus className="h-4 w-4" />
        开启新对话
      </button>
    </div>
  );
}

/** color 只留给未开放工具那组自定义色，缺省走主题强调色。 */
function ToolIcon(props: { icon: React.ComponentType<{ className?: string }>; color?: string }) {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
        !props.color && 'bg-primary/15 text-primary'
      )}
      style={props.color ? { backgroundColor: `${props.color}20`, color: props.color } : undefined}
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  );
}
