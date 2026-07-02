'use client';

import { useState, useRef, useEffect } from 'react';
import { SlidersHorizontal, Sparkles, Lock } from 'lucide-react';
import { ModelTierSwitcher } from './model-tier-switcher';

export function ChatToolsMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className="fixed bottom-0 left-0 z-20 flex items-end">
      {/* Popover card */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 ml-0.5 w-56 rounded-2xl border border-white/10 bg-[#1a1a2e]/95 backdrop-blur-md p-3 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Sparkles className="h-3.5 w-3.5 text-purple-400" />
            <span className="text-xs font-medium text-white/90">模型切换</span>
          </div>
          <ModelTierSwitcher />
          <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-white/10 px-3 py-2">
            <Lock className="h-3 w-3 text-white/25" />
            <span className="text-[11px] text-white/25">更多功能即将开放</span>
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
