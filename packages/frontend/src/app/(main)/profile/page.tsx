'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Gift, Pencil, Settings, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';

import { useDailyCheckinMutation, useDailyCheckinQuery, useWalletCredits } from '@/lib/api/payment';
import { usePatchUserSettingsMutation } from '@/lib/api/settings';
import { getRawInitData } from '@/lib/telegram/auth';
import { formatNumber } from '@/lib/utils/payment';
import { useUserProfileStore } from '@/stores/user-profile-store';

export default function ProfilePage() {
  const telegramUserId = useMemo(readTelegramUserId, []);
  const credits = useWalletCredits();
  const displayName = useUserProfileStore((s) => s.displayName);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  const patchSettings = usePatchUserSettingsMutation();
  const checkinQ = useDailyCheckinQuery();
  const checkin = checkinQ.data?.checkin;
  const claimCheckin = useDailyCheckinMutation();

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEdit = () => {
    setDraft(displayName);
    setIsEditing(true);
  };

  const commit = () => {
    const next = draft.trim();
    setDisplayName(next);
    patchSettings.mutate({ display_name: next || null });
    setIsEditing(false);
  };

  const cancel = () => {
    setIsEditing(false);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-[#080014] pb-10 pt-[env(safe-area-inset-top)] relative">
      {/* 顶部空间感 Banner */}
      <div className="absolute top-0 left-0 right-0 h-48 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/40 via-purple-900/10 to-transparent pointer-events-none" />

      {/* 顶部 bar：左=合并 pill（星尘数 + 商店入口），右=设置 */}
      <header className="flex items-center justify-between px-5 py-3 relative z-10">
        <Link
          href="/profile/recharge"
          aria-label={`当前星尘 ${credits}，前往星尘商店`}
          className="group inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 backdrop-blur-md px-4 py-2 text-sm transition-all duration-300 hover:bg-white/10 hover:border-white/20"
        >
          <Sparkles
            className="h-4 w-4 text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.8)] transition-transform group-hover:scale-110"
            aria-hidden
          />
          <span className="font-bold tracking-tight text-white">{formatNumber(credits)}</span>
          <span className="text-white/30">·</span>
          <span className="text-white/80 font-medium">星尘商店</span>
          <ChevronRight className="h-3.5 w-3.5 text-white/50" aria-hidden />
        </Link>
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="rounded-full text-white/60 hover:bg-white/10 hover:text-white transition-colors"
        >
          <Link href="/profile/settings" aria-label="设置">
            <Settings className="h-5 w-5" aria-hidden />
          </Link>
        </Button>
      </header>

      {/* 身份：页面重心；姓名可点击编辑 */}
      <section className="mt-8 flex flex-col items-center gap-4 px-5 relative z-10">
        <Avatar className="h-24 w-24 ring-4 ring-white/10 ring-offset-4 ring-offset-[#080014] shadow-2xl">
          <AvatarFallback className="bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-3xl font-black text-white">
            {displayName.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="text-center">
          {isEditing ? (
            <Input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={32}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
              className="h-10 w-56 text-center text-xl font-bold bg-white/5 border-white/20 text-white focus-visible:ring-indigo-500"
              aria-label="编辑显示名"
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={startEdit}
              className="group inline-flex h-auto items-center gap-1.5 px-3 py-1.5 text-xl font-bold text-white transition-all hover:bg-white/10 rounded-xl"
              aria-label="编辑显示名"
            >
              <span>{displayName}</span>
              <Pencil
                className="h-4 w-4 text-white/40 transition-colors group-hover:text-white/90"
                aria-hidden
              />
            </Button>
          )}
          <div className="mt-1 text-xs font-medium text-white/40 tracking-wider uppercase">
            ID · {telegramUserId ?? '未连接'}
          </div>
        </div>
      </section>

      {/* 核心功能资产区 */}
      <section className="mt-12 px-5 flex flex-col gap-4 relative z-10">
        {/* 余额大卡片 */}
        <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white/60">我的星尘</p>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-4xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-amber-200">
                  {formatNumber(credits)}
                </span>
              </div>
            </div>
            <Link
              href="/profile/recharge"
              className="flex h-10 items-center justify-center rounded-full bg-gradient-to-r from-amber-400 to-amber-600 px-6 text-sm font-bold text-[#080014] shadow-lg shadow-amber-500/20 transition-transform active:scale-95"
            >
              去充值
            </Link>
          </div>
        </div>

        {/* 每日签到 */}
        <Card className="overflow-hidden border-white/10 bg-white/[0.03] shadow-none rounded-[24px] backdrop-blur-md">
          <CardContent className="p-5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-400">
                <Gift className="h-6 w-6" aria-hidden />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">每日签到</h2>
                {!checkin?.can_claim && checkin?.next_claim_at ? (
                  <p className="mt-0.5 text-xs text-white/50">
                    下次可领：{formatDateTime(checkin.next_claim_at)}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-indigo-300/80">免费领取星尘，聊天可抵扣</p>
                )}
              </div>
            </div>
            <Button
              disabled={!checkin?.can_claim || claimCheckin.isPending}
              onClick={() => claimCheckin.mutate()}
              className="h-10 rounded-full bg-indigo-500 text-sm font-bold text-white hover:bg-indigo-600 shadow-md shadow-indigo-500/20 disabled:bg-white/10 disabled:text-white/40 border-0"
            >
              {claimCheckin.isPending
                ? '领取中'
                : checkin?.can_claim
                  ? `领 ${checkin.reward_credits}`
                  : '已签到'}
            </Button>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function readTelegramUserId(): string | null {
  const initData = getRawInitData();
  if (!initData) return null;

  try {
    const user = new URLSearchParams(initData).get('user');
    if (!user) return null;
    const parsed = JSON.parse(user) as { id?: number | string };
    return parsed.id !== undefined ? String(parsed.id) : null;
  } catch {
    return null;
  }
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
