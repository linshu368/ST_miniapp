'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Gift, Pencil, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
  const photoUrl = useUserProfileStore((s) => s.photoUrl);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  const patchSettings = usePatchUserSettingsMutation();
  const checkinQ = useDailyCheckinQuery();
  const checkin = checkinQ.data?.checkin;
  const claimCheckin = useDailyCheckinMutation();

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [checkinToast, setCheckinToast] = useState<{ reward: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!checkinToast) return;
    const timer = window.setTimeout(() => setCheckinToast(null), 1500);
    return () => window.clearTimeout(timer);
  }, [checkinToast]);

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

  const claimDailyCheckin = async () => {
    try {
      const data = await claimCheckin.mutateAsync();
      setCheckinToast({ reward: data.checkin.reward_credits });
    } catch {
      // Mutation state already carries the error; keep the click handler quiet.
    }
  };

  return (
    <main
      data-app-shell="profile"
      className="mx-auto flex min-h-screen max-w-md flex-col bg-[#080014] pb-10 pt-[env(safe-area-inset-top)] relative"
    >
      {/* 顶部空间感 Banner */}
      <div className="absolute top-0 left-0 right-0 h-48 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/40 via-purple-900/10 to-transparent pointer-events-none" />

      {/* 顶部 bar：左=合并 pill（星尘数 + 商店入口），右=签到 */}
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
        <div className="flex items-center gap-2">
          <Button
            disabled={!checkin?.can_claim || claimCheckin.isPending}
            onClick={() => void claimDailyCheckin()}
            size="sm"
            className="h-9 rounded-full border border-indigo-300/20 bg-indigo-400/15 px-3 text-xs font-bold text-indigo-100 shadow-none hover:bg-indigo-400/25 disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35"
            aria-label="每日签到"
          >
            <Gift className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {claimCheckin.isPending
              ? '领取中'
              : checkin?.can_claim
                ? `签到 +${checkin.reward_credits}`
                : '已签到'}
          </Button>
        </div>
      </header>

      {checkinToast && (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[9999] flex justify-center px-5">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative w-full max-w-[320px] overflow-hidden rounded-[24px] border border-white/18 bg-[#17102b]/75 px-5 py-4 text-left shadow-[0_24px_80px_rgba(0,0,0,0.45)] ring-1 ring-white/10 backdrop-blur-xl"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(129,140,248,0.42),transparent_54%)]" />
            <button
              type="button"
              onClick={() => setCheckinToast(null)}
              className="absolute right-3 top-3 z-10 rounded-full bg-white/10 p-1.5 text-white/70 transition hover:bg-white/20 hover:text-white"
              aria-label="关闭签到提示"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            <div className="relative flex items-center gap-3 pr-8">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-indigo-200/20 bg-indigo-300/15 text-indigo-100 shadow-[0_0_40px_rgba(99,102,241,0.28)]">
                <Gift className="h-6 w-6" aria-hidden />
              </div>
              <div>
                <p className="text-[10px] font-semibold tracking-[0.22em] text-indigo-100/70">
                  DAILY CHECK-IN
                </p>
                <h2 className="mt-1 text-base font-black tracking-tight text-white">签到成功</h2>
                <p className="mt-1 text-sm font-medium text-white/72">
                  星尘 +{checkinToast.reward} 已到账。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 身份：页面重心；姓名可点击编辑 */}
      <section className="mt-8 flex flex-col items-center gap-4 px-5 relative z-10">
        <Avatar className="h-24 w-24 ring-4 ring-white/10 ring-offset-4 ring-offset-[#080014] shadow-2xl">
          {photoUrl ? <AvatarImage src={photoUrl} alt={displayName} /> : null}
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
