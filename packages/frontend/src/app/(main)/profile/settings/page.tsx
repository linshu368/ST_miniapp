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
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-[#080014] text-white">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-white/5 bg-[#080014]/80 px-3 py-3 backdrop-blur-xl pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-white/60 hover:text-white hover:bg-white/10"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">设置</h1>
      </header>

      <section className="flex flex-1 flex-col gap-4 px-4 py-5 relative z-10">
        <div className="absolute top-0 left-0 right-0 h-40 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none" />

        {/* 行内控件:字号倍率 */}
        <Card className="rounded-[24px] border border-white/10 bg-white/[0.03] shadow-none backdrop-blur-md relative overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-400">
                <Type className="h-5 w-5" aria-hidden />
              </span>
              <span className="flex flex-1 flex-col">
                <span className="text-[15px] font-bold text-white tracking-wide">字号大小</span>
                <span className="mt-0.5 text-[11px] text-white/40 font-medium">
                  仅影响聊天消息文本
                </span>
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="字号大小"
              className="mt-5 flex gap-2 rounded-xl bg-white/5 p-1 border border-white/5"
            >
              {FONT_SCALE_OPTIONS.map((opt) => {
                const active = opt.id === fontScale;
                return (
                  <Button
                    key={opt.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => setFontScale(opt.id)}
                    className={cn(
                      'flex-1 rounded-[10px] transition-all duration-300 h-auto py-2 border-0',
                      active
                        ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-600'
                        : 'text-white/50 hover:text-white hover:bg-white/5'
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

        {/* 回复长度 */}
        <Card className="rounded-[24px] border border-white/10 bg-white/[0.03] shadow-none backdrop-blur-md relative overflow-hidden">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-400">
                <Type className="h-5 w-5" aria-hidden />
              </span>
              <span className="flex flex-1 flex-col">
                <span className="text-[15px] font-bold text-white tracking-wide">回复长度</span>
                <span className="mt-0.5 text-[11px] text-white/40 font-medium">
                  云端同步，跨设备生效
                </span>
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="回复长度"
              className="mt-5 grid grid-cols-4 gap-2 rounded-xl bg-white/5 p-1 border border-white/5"
            >
              {WORD_COUNT_OPTIONS.map((opt) => {
                const active = opt.value === settings?.pref_word_count;
                return (
                  <Button
                    key={opt.value}
                    variant="ghost"
                    size="sm"
                    disabled={patchSettings.isPending}
                    onClick={() => updateWordCount(opt.value)}
                    className={cn(
                      'rounded-[10px] h-auto py-2 text-[12px] font-bold transition-all duration-300 border-0',
                      active
                        ? 'bg-amber-500 text-[#080014] shadow-lg shadow-amber-500/20 hover:bg-amber-600'
                        : 'text-white/50 hover:text-white hover:bg-white/5'
                    )}
                  >
                    {opt.label}
                  </Button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* 开关选项 */}
        <Card className="rounded-[24px] border border-white/10 bg-white/[0.03] shadow-none backdrop-blur-md">
          <CardContent className="p-5 flex items-center justify-between gap-4">
            <span className="flex flex-col">
              <span className="text-[15px] font-bold text-white tracking-wide">显示选项提示</span>
              <span className="mt-0.5 text-[11px] text-white/40 font-medium">
                控制 AI 回复中是否倾向给出建议选项
              </span>
            </span>
            <Switch
              checked={settings?.pref_show_options ?? true}
              disabled={patchSettings.isPending}
              onCheckedChange={(checked) => updateShowOptions(checked)}
              className="data-[state=checked]:bg-emerald-500"
            />
          </CardContent>
        </Card>

        {/* 自定义指令 */}
        <Card className="rounded-[24px] border border-white/10 bg-white/[0.03] shadow-none backdrop-blur-md">
          <CardContent className="p-5">
            <label className="flex flex-col gap-2">
              <span className="text-[15px] font-bold text-white tracking-wide">自定义指令</span>
              <span className="text-[11px] text-white/40 font-medium leading-relaxed">
                这些指令将在每次对话时发给模型，定制你的专属 AI 体验。
              </span>
              <Textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="例如：回复更温柔一些，少用复杂术语..."
                className="mt-3 resize-none rounded-2xl bg-white/5 border border-white/10 px-4 py-3 text-sm text-white placeholder:text-white/20 focus-visible:ring-indigo-500/50 transition-all"
              />
            </label>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-[11px] text-white/30 font-medium tracking-wider">
                {customInstructions.length} / 2000
              </span>
              <Button
                disabled={patchSettings.isPending}
                onClick={saveCustomInstructions}
                className="rounded-full px-6 h-9 text-xs font-bold bg-white/10 text-white hover:bg-white/20 border-0 transition-colors"
              >
                保存
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 跳转行 */}
        <ul className="overflow-hidden rounded-[24px] border border-white/10 bg-white/[0.03] backdrop-blur-md mt-2">
          {NAV_ROWS.map((row, idx) => {
            const Icon = row.icon;
            return (
              <li key={row.href}>
                <Link
                  href={row.href}
                  className={`flex items-center gap-4 px-5 py-4 transition-colors hover:bg-white/5 group ${
                    idx > 0 ? 'border-t border-white/5' : ''
                  }`}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 text-white/60 group-hover:bg-white/10 group-hover:text-white transition-colors">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="flex flex-1 flex-col">
                    <span className="text-[15px] font-bold text-white tracking-wide">
                      {row.label}
                    </span>
                    {row.hint ? (
                      <span className="mt-0.5 text-[11px] text-white/40 font-medium">
                        {row.hint}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    className="h-4 w-4 text-white/20 group-hover:text-white/60 transition-colors"
                    aria-hidden
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
