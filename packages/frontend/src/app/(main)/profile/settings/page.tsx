'use client';

import { useCallback } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Palette, Receipt, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PreferredWordCount } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import { usePatchUserSettingsMutation, useUserSettingsQuery } from '@/lib/api/settings';
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

const WORD_COUNT_OPTIONS: Array<{ value: PreferredWordCount; label: string }> = [
  { value: '100-300', label: '简短' },
  { value: '300-500', label: '标准' },
  { value: '500-800', label: '细致' },
  { value: '800+', label: '长文' },
];

export default function SettingsPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const fontScale = useFontScaleStore((s) => s.scale);
  const setFontScale = useFontScaleStore((s) => s.setScale);
  const settingsQuery = useUserSettingsQuery();
  const patchSettings = usePatchUserSettingsMutation();
  const settings = settingsQuery.data?.settings;
  const [customInstructions, setCustomInstructions] = useState('');

  useEffect(() => {
    setCustomInstructions(settings?.pref_custom_instructions ?? '');
  }, [settings?.pref_custom_instructions]);

  const updateWordCount = (pref_word_count: PreferredWordCount) => {
    patchSettings.mutate({ pref_word_count });
  };

  const updateShowOptions = (pref_show_options: boolean) => {
    patchSettings.mutate({ pref_show_options });
  };

  const saveCustomInstructions = () => {
    patchSettings.mutate({
      pref_custom_instructions: customInstructions.trim() || null,
    });
  };

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
        <h1 className="text-base font-semibold">设置</h1>
      </header>

      <section className="flex flex-1 flex-col gap-4 px-3 py-4">
        {/* 行内控件:字号倍率(无障碍偏好,与主题正交) */}
        <Card className="rounded-2xl border-border/60 bg-card/40 shadow-none">
          <CardContent className="p-4">
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
              className="mt-4 flex gap-1.5 rounded-xl bg-secondary/40 p-1"
            >
              {FONT_SCALE_OPTIONS.map((opt) => {
                const active = opt.id === fontScale;
                return (
                  <Button
                    key={opt.id}
                    variant={active ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setFontScale(opt.id)}
                    className={cn(
                      'flex-1 rounded-lg transition-colors h-auto py-1.5',
                      active
                        ? 'bg-background text-foreground shadow-sm hover:bg-background'
                        : 'text-muted-foreground'
                    )}
                    style={{ fontSize: `calc(13px * ${opt.multiplier})` }}
                  >
                    {opt.label}
                  </Button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/40 shadow-none">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground">
                <Type className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex flex-1 flex-col">
                <span className="text-[15px] font-medium text-foreground">回复长度</span>
                <span className="mt-0.5 text-[11px] text-muted-foreground/70">
                  同步到 MiniApp 后端设置
                </span>
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="回复长度"
              className="mt-4 grid grid-cols-4 gap-1.5 rounded-xl bg-secondary/40 p-1"
            >
              {WORD_COUNT_OPTIONS.map((opt) => {
                const active = opt.value === settings?.pref_word_count;
                return (
                  <Button
                    key={opt.value}
                    variant={active ? 'default' : 'ghost'}
                    size="sm"
                    disabled={patchSettings.isPending}
                    onClick={() => updateWordCount(opt.value)}
                    className={cn(
                      'rounded-lg h-auto py-1.5 text-[12px] font-medium transition-colors',
                      active
                        ? 'bg-background text-foreground shadow-sm hover:bg-background'
                        : 'text-muted-foreground'
                    )}
                  >
                    {opt.label}
                  </Button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/40 shadow-none">
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-[15px] font-medium text-foreground">显示选项提示</span>
              <span className="mt-0.5 text-[11px] text-muted-foreground/70">
                控制回复中是否倾向给出选择项
              </span>
            </span>
            <Switch
              checked={settings?.pref_show_options ?? true}
              disabled={patchSettings.isPending}
              onCheckedChange={(checked) => updateShowOptions(checked)}
            />
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border/60 bg-card/40 shadow-none">
          <CardContent className="p-4">
            <label className="flex flex-col gap-2">
              <span className="text-[15px] font-medium text-foreground">自定义指令</span>
              <span className="text-[11px] text-muted-foreground/70">
                会保存到 MiniApp 设置表，不写入 ST settings。
              </span>
              <Textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="例如：回复更温柔一些，少用复杂术语。"
                className="mt-2 resize-none rounded-xl bg-background/70 px-3 py-2 text-sm transition-colors"
              />
            </label>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground/70">
                {customInstructions.length}/2000
              </span>
              <Button
                disabled={patchSettings.isPending}
                onClick={saveCustomInstructions}
                className="rounded-full px-5 h-8 text-xs font-medium"
              >
                保存
              </Button>
            </div>
          </CardContent>
        </Card>

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
