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
    <div ref={containerRef} className="fixed bottom-0 left-0 z-20 flex flex-col items-start">
      {/* Popover card */}
      {open && (
        <div className="mb-2 ml-2 w-56 rounded-2xl border border-white/10 bg-[#1a1a2e]/95 backdrop-blur-md p-3 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-200">
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

      {/* Tools trigger */}
      <div className="flex items-center h-[52px] pl-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-full p-2.5 text-white/60 hover:text-white/90 transition-colors"
          aria-label="工具菜单"
        >
          <SlidersHorizontal className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
