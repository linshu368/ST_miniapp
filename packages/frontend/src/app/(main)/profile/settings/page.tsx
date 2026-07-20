'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Moon, Palette, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTelegramBackButton } from '@/lib/telegram';
import { useAppearanceStore, type AppearanceMode } from '@/stores/appearance-store';
import { cn } from '@/lib/utils';

export default function SettingsPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);
  const mode = useAppearanceStore((state) => state.mode);
  const setMode = useAppearanceStore((state) => state.setMode);

  return (
    <main className="app-page mx-auto flex max-w-md flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-3 backdrop-blur-xl pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">设置</h1>
      </header>

      <section className="space-y-4 px-4 py-6">
        <div className="app-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Appearance
          </p>
          <h2 className="mt-1 text-lg font-bold">全站外观</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            选择会同步应用到大厅、聊天和所有功能页。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <ModeButton
              mode="light"
              current={mode}
              icon={<Sun className="h-5 w-5" />}
              label="亮色"
              onSelect={setMode}
            />
            <ModeButton
              mode="dark"
              current={mode}
              icon={<Moon className="h-5 w-5" />}
              label="暗色"
              onSelect={setMode}
            />
          </div>
        </div>

        <Link
          href="/profile/settings/theme"
          className="app-surface flex items-center gap-3 p-4 transition hover:border-primary/30"
        >
          <span className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Palette className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">聊天消息配色</span>
            <span className="block text-sm text-muted-foreground">调整正文、动作和对白颜色</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </section>
    </main>
  );
}

function ModeButton(props: {
  mode: AppearanceMode;
  current: AppearanceMode;
  icon: React.ReactNode;
  label: string;
  onSelect: (mode: AppearanceMode) => void;
}) {
  const active = props.mode === props.current;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.mode)}
      aria-pressed={active}
      className={cn(
        'flex items-center justify-center gap-2 rounded-2xl border px-4 py-4 text-sm font-semibold transition',
        active
          ? 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/15'
          : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground'
      )}
    >
      {props.icon}
      {props.label}
    </button>
  );
}
