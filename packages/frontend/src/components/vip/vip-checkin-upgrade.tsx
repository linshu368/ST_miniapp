'use client';

import type { DailyCheckinStatus } from '@miniapp/shared';

import { ChevronRight, Crown, Loader2 } from 'lucide-react';

import { rewardSplitLabel } from '@/lib/vip/rewards';
import { formatNumber } from '@/lib/utils/payment';

export function VipCheckinUpgrade({
  dailyCredits,
  mainCredits = 0,
  onOpen,
  pending = false,
  compact = false,
}: {
  dailyCredits: number;
  mainCredits?: number;
  onOpen: () => void;
  pending?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={onOpen}
        aria-label={`开通 VIP，立即恢复每天签到 ${formatNumber(dailyCredits)} 星尘`}
        className="group flex min-h-12 w-full items-center gap-2.5 rounded-lg py-2 text-left text-[#cdb3a4] transition-colors hover:text-[#f0d5bf] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7b4bf] disabled:opacity-60 motion-reduce:transition-none"
      >
        <Crown className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 text-[11px] leading-[18px]">
          开通 VIP，签到立即恢复
          <span className="ml-1 inline-block font-semibold text-[#efd8c2]">
            {mainCredits > 0
              ? rewardSplitLabel(dailyCredits - mainCredits, mainCredits)
              : `${formatNumber(dailyCredits)} 星尘 / 天`}
          </span>
        </span>
        {pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={onOpen}
      aria-label={`开通 VIP，立即恢复每天签到 ${formatNumber(dailyCredits)} 星尘`}
      className="group block w-full rounded-[18px] border border-primary/25 bg-[linear-gradient(110deg,hsl(var(--primary)/0.12),hsl(var(--primary)/0.03))] px-3.5 py-3 text-left transition-colors hover:border-primary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold leading-5 text-primary">
        <Crown className="size-3 shrink-0" aria-hidden />
        <span>开通 VIP，立即恢复</span>
      </span>
      <span className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-baseline gap-x-1.5 text-primary">
          <strong className="text-[26px] font-bold leading-8 tabular-nums tracking-tight">
            {formatNumber(dailyCredits)}
          </strong>
          <span className="text-xs font-medium">星尘 / 天</span>
        </span>
        <span className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-full bg-primary px-3 text-[11px] font-bold text-primary-foreground">
          {pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          {pending ? '打开中' : '去开通'}
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </span>
      <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">
        {mainCredits > 0
          ? rewardSplitLabel(dailyCredits - mainCredits, mainCredits)
          : '会员有效期内，每天签到领取'}
      </span>
    </button>
  );
}

export function CheckinRewardStatus({
  checkin,
  checkinReadFailed,
  hasClaimed,
}: {
  checkin: DailyCheckinStatus | undefined;
  checkinReadFailed: boolean;
  hasClaimed: boolean;
}) {
  return (
    <p
      className="mt-0.5 text-[11px] leading-5 text-[#aaa0a9]"
      role={!checkin ? 'status' : undefined}
    >
      {checkinReadFailed ? (
        '签到状态没查到，稍后再试'
      ) : !checkin ? (
        '正在查看今日奖励…'
      ) : hasClaimed ? (
        '今日星尘已领取'
      ) : (
        <>
          <span className="font-medium tabular-nums text-[#dcc0ca]">
            +{formatNumber(checkin.reward_credits)}
          </span>{' '}
          星尘待领取
          {(checkin.main_reward_credits ?? 0) > 0 ? (
            <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">
              {rewardSplitLabel(
                checkin.bonus_reward_credits ?? 0,
                checkin.main_reward_credits ?? 0
              )}
            </span>
          ) : null}
        </>
      )}
    </p>
  );
}
