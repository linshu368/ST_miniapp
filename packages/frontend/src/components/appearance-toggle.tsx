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
        'inline-flex size-10 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition hover:border-primary/40 hover:text-primary active:scale-95',
        className
      )}
    >
      {mode === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
