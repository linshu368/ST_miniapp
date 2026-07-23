'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft } from 'lucide-react';

import { THEME_PRESETS } from '@/lib/themes/presets';
import { useTelegramBackButton } from '@/lib/telegram';
import { useThemeStore } from '@/stores/theme-store';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:text-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-semibold">消息主题</h1>
      </header>

      <p className="px-4 pt-4 text-[12px] leading-relaxed text-muted-foreground/80">
        主题控制助手消息中 4 类文字的颜色:主文 · 动作 · 对白 · 下划线。
        <br />
        样例同步预览,选哪个用哪个。
      </p>

      <ul className="grid grid-cols-1 gap-3 px-3 py-4 sm:grid-cols-2">
        {THEME_PRESETS.map((theme) => {
          const active = theme.id === themeId;
          return (
            <li key={theme.id}>
              <Card
                role="button"
                tabIndex={0}
                onClick={() => setThemeId(theme.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setThemeId(theme.id);
                  }
                }}
                className={cn(
                  'relative overflow-hidden rounded-2xl border transition-all duration-200 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:-translate-y-0.5',
                  active
                    ? 'border-primary/60 bg-primary/5 shadow-md shadow-primary/5'
                    : 'border-border/40 bg-card/40 hover:border-border/80 hover:bg-secondary/20 hover:shadow-sm'
                )}
                aria-pressed={active}
              >
                {active && (
                  <div className="absolute right-0 top-0 rounded-bl-xl bg-primary/20 p-1.5">
                    <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                  </div>
                )}
                <CardContent className="flex w-full flex-col gap-3 px-4 py-4 text-left">
                  <div>
                    <span className="text-[15px] font-semibold tracking-tight text-foreground">
                      {theme.name}
                    </span>
                    <p className="mt-1 text-[12px] text-muted-foreground/80 leading-tight">
                      {theme.blurb}
                    </p>
                  </div>
                  <ThemeSample palette={theme.palette} />
                </CardContent>
              </Card>
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
  return (
    <div className="rounded-xl border border-border/30 bg-background/80 px-3.5 py-3 text-[13px] leading-relaxed shadow-sm inset-shadow-sm">
      <span style={{ color: palette.italics, fontStyle: 'italic' }}>她抬起头，</span>
      <span style={{ color: palette.main }}>看着你，然后说，</span>
      <span style={{ color: palette.quote }}>“你来了。”</span>
      <br />
      <span style={{ color: palette.main }}>关键词：</span>
      <span
        style={{
          color: palette.underline,
          textDecoration: 'underline',
          textDecorationColor: palette.underline,
          textUnderlineOffset: 3,
          textDecorationThickness: 1.5,
        }}
        className="font-medium"
      >
        你
      </span>
      <span style={{ color: palette.main }}>。</span>
    </div>
  );
}
