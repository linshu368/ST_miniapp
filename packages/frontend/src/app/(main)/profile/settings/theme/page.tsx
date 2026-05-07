'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft } from 'lucide-react';

import { THEME_PRESETS } from '@/lib/themes/presets';
import { useTelegramBackButton } from '@/lib/telegram';
import { useThemeStore } from '@/stores/theme-store';
import { cn } from '@/lib/utils';

export default function ThemePage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile/settings'), [router]);
  useTelegramBackButton(goBack);

  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-3 backdrop-blur-md">
        <button
          type="button"
          aria-label="返回"
          onClick={goBack}
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="text-base font-semibold">消息主题</h1>
      </header>

      <p className="px-4 pt-4 text-[12px] leading-relaxed text-muted-foreground/80">
        主题控制助手消息中 4 类文字的颜色:主文 · 动作 · 对白 · 下划线。
        <br />
        样例同步预览,选哪个用哪个。
      </p>

      <ul className="flex flex-1 flex-col gap-2 px-3 py-4">
        {THEME_PRESETS.map((theme) => {
          const active = theme.id === themeId;
          return (
            <li key={theme.id}>
              <button
                type="button"
                onClick={() => setThemeId(theme.id)}
                className={cn(
                  'flex w-full flex-col gap-2.5 rounded-2xl border bg-card/40 px-4 py-3.5 text-left transition-colors',
                  active
                    ? 'border-primary/70 bg-primary/5'
                    : 'border-border/60 hover:border-border hover:bg-secondary/30'
                )}
                aria-pressed={active}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-medium text-foreground">{theme.name}</span>
                  {active && <Check className="h-4 w-4 text-primary" aria-hidden />}
                </div>
                <p className="text-[11px] text-muted-foreground/80">{theme.blurb}</p>
                <ThemeSample palette={theme.palette} />
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function ThemeSample({
  palette,
}: {
  palette: { main: string; italics: string; quote: string; underline: string };
}) {
  // 不走 .mes-text(避免被全局主题 var 影响),直接 inline color
  return (
    <div className="rounded-lg border border-border/40 bg-background/60 px-3 py-2.5 text-[13px] leading-[1.55]">
      <span style={{ color: palette.italics, fontStyle: 'italic' }}>她抬起头,</span>
      <span style={{ color: palette.main }}>看着你,然后说,</span>
      <span style={{ color: palette.quote }}>“你来了。”</span>
      <br />
      <span style={{ color: palette.main }}>关键词:</span>
      <span
        style={{
          color: palette.underline,
          textDecoration: 'underline',
          textDecorationColor: palette.underline,
          textUnderlineOffset: 2,
        }}
      >
        你
      </span>
      <span style={{ color: palette.main }}>。</span>
    </div>
  );
}
