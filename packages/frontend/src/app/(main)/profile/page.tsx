'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Gift, Pencil, Settings, Sparkles } from 'lucide-react';

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
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10 pt-[env(safe-area-inset-top)]">
      {/* 顶部 bar：左=合并 pill（星尘数 + 商店入口），右=设置 */}
      <header className="flex items-center justify-between py-3">
        <Link
          href="/profile/recharge"
          aria-label={`当前星尘 ${credits}，前往星尘商店`}
          className="animate-stardust-pulse inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-gradient-to-r from-sky-500/10 via-card/60 to-indigo-500/10 px-3.5 py-2 text-sm transition-colors duration-300 hover:border-sky-400/60 hover:[animation-play-state:paused] hover:shadow-[0_0_26px_-4px_rgba(56,189,248,0.7),inset_0_0_16px_-3px_rgba(56,189,248,0.4)]"
        >
          <Sparkles
            className="h-4 w-4 text-sky-300 drop-shadow-[0_0_4px_rgba(56,189,248,0.7)]"
            aria-hidden
          />
          <span className="font-semibold tabular-nums">{formatNumber(credits)}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-foreground/85">星尘商店</span>
          <ChevronRight className="h-3.5 w-3.5 text-sky-300/80" aria-hidden />
        </Link>
        <Link
          href="/profile/settings"
          aria-label="设置"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground"
        >
          <Settings className="h-5 w-5" aria-hidden />
        </Link>
      </header>

      {/* 身份：页面重心；姓名可点击编辑 → 影响 chat 里的 {{user}} 宏 */}
      <section className="mt-10 flex flex-col items-center gap-3">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 via-purple-500 to-blue-500 text-3xl font-black text-white">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="text-center">
          {isEditing ? (
            <input
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
              className="w-48 rounded-md border border-border bg-card px-3 py-1.5 text-center text-lg font-semibold focus:border-primary focus:outline-none"
              aria-label="编辑显示名"
            />
          ) : (
            <button
              type="button"
              onClick={startEdit}
              className="group inline-flex items-center gap-1.5 text-lg font-semibold transition-colors hover:text-primary"
              aria-label="编辑显示名"
            >
              <span>{displayName}</span>
              <Pencil
                className="h-3.5 w-3.5 text-muted-foreground/60 transition-colors group-hover:text-primary"
                aria-hidden
              />
            </button>
          )}
          <div className="mt-0.5 text-[11px] text-muted-foreground/70">
            ID · {telegramUserId ?? '未连接 Telegram'}
          </div>
        </div>
      </section>

      <section className="mt-8 rounded-3xl border border-sky-500/20 bg-gradient-to-br from-sky-500/10 via-card to-indigo-500/10 p-4 shadow-[0_18px_60px_-40px_rgba(56,189,248,0.7)]">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-300">
            <Gift className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-foreground">每日签到</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  奖励进入赠送星尘，聊天扣费时自动抵扣
                </p>
              </div>
              <button
                type="button"
                disabled={!checkin?.can_claim || claimCheckin.isPending}
                onClick={() => claimCheckin.mutate()}
                className="h-9 shrink-0 rounded-full bg-sky-500 px-3 text-xs font-bold text-white shadow-lg shadow-sky-500/20 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {claimCheckin.isPending
                  ? '领取中'
                  : checkin?.can_claim
                    ? `领 ${checkin.reward_credits}`
                    : '已签到'}
              </button>
            </div>
            {!checkin?.can_claim && checkin?.next_claim_at ? (
              <p className="mt-3 text-[11px] text-muted-foreground/80">
                下次可领：{formatDateTime(checkin.next_claim_at)}
              </p>
            ) : (
              <p className="mt-3 text-[11px] text-sky-300/80">
                每 24 小时可领取一次，数量由运营配置调整。
              </p>
            )}
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
