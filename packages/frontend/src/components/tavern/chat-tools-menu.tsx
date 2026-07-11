'use client';

import { useState, useRef, useEffect } from 'react';
import { SlidersHorizontal, Sparkles, Lock, MessageSquarePlus, ChevronLeft } from 'lucide-react';
import { ModelTierSwitcher } from './model-tier-switcher';
import { platformAction, useBridgeStatus } from '@/lib/bridge';

type MenuState = 'main' | 'models';

export function ChatToolsMenu() {
  const [open, setOpen] = useState(false);
  const [menuState, setMenuState] = useState<MenuState>('main');
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeStatus = useBridgeStatus();
  const bridgeReady = bridgeStatus === 'ready';

  useEffect(() => {
    if (!open) {
      // 弹窗关闭时重置状态
      setTimeout(() => setMenuState('main'), 200);
      return;
    }
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  async function handleNewChat() {
    if (!bridgeReady) return;
    try {
      await platformAction('newChat', {});
    } catch (err) {
      console.error('[ChatToolsMenu] newChat failed:', err);
    }
  }

  return (
    <div ref={containerRef} className="relative flex h-12 items-center">
      {open && (
        <div
          className="fixed inset-0 z-0"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
          aria-hidden="true"
        />
      )}

      {open && (
        <div className="absolute left-0 top-[calc(100%+0.4rem)] z-10 max-h-[min(24rem,calc(100dvh-4.25rem-env(safe-area-inset-top)-env(safe-area-inset-bottom)))] w-[min(15rem,calc(100vw-1rem))] overflow-y-auto overflow-x-hidden rounded-2xl border border-white/[0.08] bg-[#222031] p-3 shadow-[0_20px_60px_rgba(0,0,0,0.5)] animate-in fade-in slide-in-from-top-2 duration-200">
          <div
            className="flex w-[200%] transition-transform duration-300 ease-in-out"
            style={{ transform: menuState === 'main' ? 'translateX(0)' : 'translateX(-50%)' }}
          >
            {/* 主菜单 */}
            <div className="w-1/2 shrink-0 pr-3">
              <div className="mb-2.5 flex items-center gap-1.5 px-1">
                <SlidersHorizontal className="h-3.5 w-3.5 text-white/70" />
                <span className="text-xs font-medium text-white/90">工具菜单</span>
              </div>

              <button
                onClick={() => setMenuState('models')}
                className="flex min-h-10 w-full items-center justify-between rounded-xl px-3 py-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-400" />
                  <span className="text-xs font-medium">模型切换</span>
                </div>
              </button>

              <button
                disabled={!bridgeReady}
                onClick={() => {
                  handleNewChat();
                  setOpen(false);
                }}
                className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-xl px-3 py-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MessageSquarePlus className="h-4 w-4" />
                <span className="text-xs font-medium">开启新对话</span>
              </button>

              <div className="mt-3 flex items-center gap-1.5 rounded-xl border border-dashed border-white/10 px-3 py-2">
                <Lock className="h-3 w-3 text-white/25" />
                <span className="text-[11px] text-white/25">更多功能即将开放</span>
              </div>
            </div>

            {/* 模型切换二级菜单 */}
            <div className="w-1/2 shrink-0 pl-3">
              <div className="mb-2.5 flex items-center gap-1.5">
                <button
                  onClick={() => setMenuState('main')}
                  className="-ml-1 flex size-8 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                  aria-label="返回工具菜单"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <Sparkles className="h-3.5 w-3.5 text-purple-400" />
                <span className="text-xs font-medium text-white/90">模型切换</span>
              </div>
              <ModelTierSwitcher />
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="relative z-10 flex size-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 hover:text-white active:scale-95"
        aria-label="工具菜单"
        aria-expanded={open}
      >
        <SlidersHorizontal className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}
