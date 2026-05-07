'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Palette, Receipt, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useTelegramBackButton } from '@/lib/telegram';
import { FONT_SCALE_OPTIONS, useFontScaleStore } from '@/stores/font-scale-store';
import { cn } from '@/lib/utils';

interface SettingsRow {
  href: string;
  icon: LucideIcon;
  label: string;
  hint?: string;
}

const NAV_ROWS: SettingsRow[] = [
  {
    href: '/profile/settings/theme',
    icon: Palette,
    label: '消息主题',
    hint: '调整对白 / 动作 / 主文颜色',
  },
  {
    href: '/profile/orders',
    icon: Receipt,
    label: '我的订单',
    hint: '查看充值订单状态',
  },
];

export default function SettingsPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const fontScale = useFontScaleStore((s) => s.scale);
  const setFontScale = useFontScaleStore((s) => s.setScale);

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
        <h1 className="text-base font-semibold">设置</h1>
      </header>

      <section className="flex flex-1 flex-col gap-3 px-3 py-4">
        {/* 行内控件:字号倍率(无障碍偏好,与主题正交) */}
        <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground">
              <Type className="h-4 w-4" aria-hidden />
            </span>
            <span className="flex flex-1 flex-col">
              <span className="text-[15px] font-medium text-foreground">字号大小</span>
              <span className="mt-0.5 text-[11px] text-muted-foreground/70">
                仅影响 chat 消息文本
              </span>
            </span>
          </div>
          <div
            role="radiogroup"
            aria-label="字号大小"
            className="mt-3 flex gap-1.5 rounded-xl bg-secondary/40 p-1"
          >
            {FONT_SCALE_OPTIONS.map((opt) => {
              const active = opt.id === fontScale;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setFontScale(opt.id)}
                  className={cn(
                    'flex-1 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  style={{ fontSize: `calc(13px * ${opt.multiplier})` }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 跳转行 */}
        <ul className="overflow-hidden rounded-2xl border border-border/60 bg-card/40">
          {NAV_ROWS.map((row, idx) => {
            const Icon = row.icon;
            return (
              <li key={row.href}>
                <Link
                  href={row.href}
                  className={`flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-secondary/40 ${
                    idx > 0 ? 'border-t border-border/40' : ''
                  }`}
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="flex flex-1 flex-col">
                    <span className="text-[15px] font-medium text-foreground">{row.label}</span>
                    {row.hint ? (
                      <span className="mt-0.5 text-[11px] text-muted-foreground/70">
                        {row.hint}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
