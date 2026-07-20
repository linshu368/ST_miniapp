'use client';

import { Moon, Sun } from 'lucide-react';
import { useAppearanceStore } from '@/stores/appearance-store';
import { cn } from '@/lib/utils';

export function AppearanceToggle({ className }: { className?: string }) {
  const mode = useAppearanceStore((state) => state.mode);
  const toggleMode = useAppearanceStore((state) => state.toggleMode);

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={mode === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
      title={mode === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full border border-border bg-muted px-2 text-[11px] font-bold text-muted-foreground shadow-sm transition hover:border-primary/40 hover:bg-muted hover:text-primary active:scale-95 sm:h-9 sm:px-2.5',
        className
      )}
    >
      {mode === 'dark' ? (
        <Sun className="h-3.5 w-3.5 text-primary" />
      ) : (
        <Moon className="h-3.5 w-3.5 text-primary" />
      )}
      <span>明暗</span>
    </button>
  );
}
