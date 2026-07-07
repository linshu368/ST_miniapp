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
    <div ref={containerRef} className="fixed bottom-0 left-0 z-20 flex items-end">
      {/* Popover card */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 ml-0.5 w-56 rounded-2xl border border-white/10 bg-[#1a1a2e]/95 backdrop-blur-md p-3 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200 overflow-hidden">
          <div
            className="flex w-[200%] transition-transform duration-300 ease-in-out"
            style={{ transform: menuState === 'main' ? 'translateX(0)' : 'translateX(-50%)' }}
          >
            {/* 主菜单 */}
            <div className="w-1/2 shrink-0 pr-3">
              <div className="flex items-center gap-1.5 mb-2.5 px-1">
                <SlidersHorizontal className="h-3.5 w-3.5 text-white/70" />
                <span className="text-xs font-medium text-white/90">工具菜单</span>
              </div>

              <button
                onClick={() => setMenuState('models')}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
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
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-1"
              >
                <MessageSquarePlus className="h-4 w-4" />
                <span className="text-xs font-medium">开启新对话</span>
              </button>

              <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-white/10 px-3 py-2">
                <Lock className="h-3 w-3 text-white/25" />
                <span className="text-[11px] text-white/25">更多功能即将开放</span>
              </div>
            </div>

            {/* 模型切换二级菜单 */}
            <div className="w-1/2 shrink-0 pl-3">
              <div className="flex items-center gap-1.5 mb-2.5">
                <button
                  onClick={() => setMenuState('main')}
                  className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white transition-colors -ml-1"
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

      {/* Tools trigger — visually flush with ST input bar */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-10 h-[38px] bg-[#1a1a2e]/95 backdrop-blur-md border border-white/10 border-r-0 text-white/70 hover:text-white hover:bg-[#1a1a2e] transition-colors active:scale-95"
        aria-label="工具菜单"
      >
        <SlidersHorizontal className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}
