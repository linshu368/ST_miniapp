'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { useFreshAfterFetch, usePageReady } from '@/lib/perf/page-ready';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, Check, Gift, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VipCheckinUpgrade, CheckinRewardStatus } from '@/components/vip/vip-checkin-upgrade';
import { ProfileHeader } from '@/components/profile/profile-header';
import { ProfileStardustBalance } from '@/components/profile/profile-stardust-balance';
import {
  useProfileMessagePrefetch,
  useProfileReadiness,
} from '@/components/profile/profile-readiness';

import {
  useDailyCheckinMutation,
  useDailyCheckinQuery,
  useWalletBalanceQuery,
  usePaymentPlansQuery,
} from '@/lib/api/payment';
import { useMarkVipEntryViewedMutation, useVipStatusQuery } from '@/lib/api/vip';
import { useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { markCriticalSettled } from '@/lib/entry-phase';
import { getRawInitData } from '@/lib/telegram/auth';
import { checkinRewardLines } from '@/lib/vip/presentation';

const VipEntryCard = dynamic(
  () => import('@/components/vip/vip-entry-card').then((module) => module.VipEntryCard),
  { ssr: false, loading: ProfileVipPlaceholder }
);

const ProfileServicesSection = dynamic(
  () =>
    import('@/components/profile/profile-services-section').then(
      (module) => module.ProfileServicesSection
    ),
  { ssr: false, loading: ProfileServicesFallback }
);

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const telegramUserId = useMemo(readTelegramUserId, []);
  const { secondaryReadsReady } = useProfileReadiness();
  const wallet = useWalletBalanceQuery();
  const walletFresh = useFreshAfterFetch(
    wallet.isFetching,
    wallet.data !== undefined,
    wallet.isError
  );
  // 头像、编辑与功能入口已经是真实可交互内容；余额保留独立 loading/error，不阻塞整页。
  usePageReady('/profile', true, walletFresh, false);
  useEffect(() => {
    // Profile 没有必须等待的数据型 P0；shell commit 后即可放行应用级后台预热。
    markCriticalSettled();
  }, []);
  // BottomNav 同屏常驻并负责轮询，这里只订阅缓存，避免同一端点两个 interval 各打一份。
  const unread = useNotificationUnreadCountQuery({ poll: false, enabled: false });
  useProfileMessagePrefetch(
    queryClient,
    router,
    unread.data?.official ?? 0,
    unread.data?.personal ?? 0
  );
  const checkinQ = useDailyCheckinQuery({ enabled: secondaryReadsReady });
  const checkin = checkinQ.data?.checkin;
  const claimCheckin = useDailyCheckinMutation();
  const vipStatus = useVipStatusQuery({ enabled: secondaryReadsReady });
  const vipDailyCredits = vipStatus.data?.benefits?.checkin_vip_credits;
  const checkinUpgradeCredits =
    !vipStatus.isError &&
    vipStatus.data?.active === false &&
    typeof vipDailyCredits === 'number' &&
    Number.isInteger(vipDailyCredits) &&
    vipDailyCredits > 0
      ? vipDailyCredits
      : null;
  const paymentPlans = usePaymentPlansQuery({ enabled: secondaryReadsReady });
  const markVipSeen = useMarkVipEntryViewedMutation();

  const [checkinToast, setCheckinToast] = useState<string[] | null>(null);
  const [vipError, setVipError] = useState<string | null>(null);
  const openingVip = useRef(false);

  useEffect(() => {
    // A confirmation with a CTA must remain available until the user opens or dismisses it.
    if (!checkinToast || checkinUpgradeCredits !== null) return;
    const timer = window.setTimeout(
      () => setCheckinToast(null),
      checkinToast.length > 1 ? 3200 : 1500
    );
    return () => window.clearTimeout(timer);
  }, [checkinToast, checkinUpgradeCredits]);

  const claimDailyCheckin = async () => {
    const action = startAction('daily_checkin');
    try {
      // 反馈必须等签到真正到账、状态同步完再给，不能在请求发出那一刻就算数——
      // 否则测的只是「点击有没有反应」，不是「签到到底有没有成功、花了多久」。
      const data = await claimCheckin.mutateAsync();
      setCheckinToast(checkinRewardLines(data.checkin));
      feedbackAfterPaint(action);
    } catch {
      // Mutation state already carries the error; keep the click handler quiet.
      // 但看门狗必须在这清掉，否则 2.5 秒后还会补发一条过期的 action_stall。
      action.feedback();
    }
  };

  const openVip = async () => {
    if (openingVip.current || vipStatus.isLoading || markVipSeen.isPending) return;
    openingVip.current = true;
    setVipError(null);
    try {
      if (vipStatus.data?.entry_badge_visible) {
        await markVipSeen.mutateAsync();
      }
      router.push('/vip');
    } catch {
      setVipError('VIP 页没打开，再试一次吧');
    } finally {
      openingVip.current = false;
    }
  };

  const checkinReadFailed = checkinQ.isError && !checkin;
  const hasClaimed = checkin?.can_claim === false;

  return (
    <main
      data-app-shell="profile"
      className="relative mx-auto min-h-[calc(100dvh-var(--app-nav-space))] w-full max-w-lg bg-page px-4 pb-7 pt-[calc(env(safe-area-inset-top)+1.5rem)]"
    >
      <h1 className="sr-only">我的</h1>

      <ProfileHeader
        userId={telegramUserId}
        vipActive={vipStatus.data?.active === true}
        hasUnread={(unread.data?.total ?? 0) > 0}
      />

      <div className="relative overflow-hidden rounded-[24px] border border-border dark:border-white/[0.07] bg-surface">
        <ProfileStardustBalance
          mainCredits={wallet.data?.main_credits}
          bonusCredits={wallet.data?.bonus_credits}
          isError={wallet.isError}
          isFetching={wallet.isFetching}
          onRetry={() => void wallet.refetch()}
        />

        <section
          aria-label="每日签到"
          className="relative mx-5 border-t border-border dark:border-white/[0.07] pb-1 pt-3"
        >
          <div className="flex items-center gap-3">
            <span
              className={`grid size-9 shrink-0 place-items-center rounded-xl ${hasClaimed ? 'bg-secondary dark:bg-white/[0.03] text-muted-foreground dark:text-[#a79da6]' : 'bg-mauve/10 dark:bg-[#d7b4bf]/10 text-mauve dark:text-[#dcc0ca]'}`}
            >
              {hasClaimed ? (
                <Check className="size-5" aria-hidden />
              ) : (
                <Gift className="size-5" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h2 className="text-[13px] font-medium text-foreground dark:text-[#eee7e5]">
                  每日签到
                </h2>
                <span className="text-[10px] text-muted-foreground dark:text-[#8d838d]">
                  每天 00:00 更新
                </span>
              </div>
              <CheckinRewardStatus
                checkin={checkin}
                checkinReadFailed={checkinReadFailed}
                hasClaimed={hasClaimed}
              />
            </div>
            <Button
              type="button"
              disabled={
                claimCheckin.isPending ||
                (!checkin?.can_claim && !checkinReadFailed) ||
                (checkinReadFailed && checkinQ.isFetching)
              }
              onClick={() =>
                checkinReadFailed ? void checkinQ.refetch() : void claimDailyCheckin()
              }
              aria-label={checkinReadFailed ? '重试加载签到' : '每日签到'}
              className={`min-h-11 shrink-0 rounded-full px-4 text-xs font-medium shadow-none ${hasClaimed ? 'bg-secondary dark:bg-white/[0.04] text-muted-foreground dark:text-[#a79da6] disabled:opacity-100' : 'bg-mauve/15 dark:bg-[#d7b4bf]/15 text-mauve dark:text-[#ecd2dc] hover:bg-mauve/25 dark:hover:bg-[#d7b4bf]/25'}`}
            >
              {claimCheckin.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              {claimCheckin.isPending
                ? '领取中'
                : checkinReadFailed
                  ? '重试'
                  : hasClaimed
                    ? '已签到'
                    : !checkin
                      ? '加载中'
                      : '签到领奖'}
            </Button>
          </div>
          {claimCheckin.isError ? (
            <p role="alert" className="mt-2 pl-14 text-xs text-destructive">
              签到未成功，请再试一次。
            </p>
          ) : null}
          {checkinUpgradeCredits !== null ? (
            <div className="mt-1">
              <VipCheckinUpgrade
                compact
                dailyCredits={checkinUpgradeCredits}
                mainCredits={vipStatus.data?.benefits?.checkin_main_credits ?? 0}
                onOpen={() => void openVip()}
                pending={markVipSeen.isPending}
              />
            </div>
          ) : null}
        </section>
      </div>

      <section aria-label="VIP 会员权益" className="relative mt-4">
        {secondaryReadsReady ? (
          <VipEntryCard
            variant="profile"
            status={vipStatus.data}
            monthlyPlan={paymentPlans.data?.vip_plans?.find((plan) => plan.id === 'month')}
            loading={vipStatus.isLoading || paymentPlans.isLoading}
            disabled={markVipSeen.isPending}
            onOpen={() => void openVip()}
          />
        ) : (
          <ProfileVipPlaceholder />
        )}
        {vipStatus.isError ? (
          <p className="px-4 pt-2 text-[11px] text-muted-foreground">会员状态没查到，稍后再看看</p>
        ) : null}
        {vipError ? (
          <p role="alert" className="px-4 pt-2 text-xs text-destructive">
            {vipError}
          </p>
        ) : null}
      </section>

      {secondaryReadsReady ? <ProfileServicesSection /> : <ProfileServicesFallback />}

      {checkinToast ? (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[9999] flex justify-center px-5">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative w-full max-w-[352px] rounded-[24px] border border-primary/25 bg-card/95 px-5 py-4 shadow-[0_20px_60px_rgb(60_40_55/18%)] dark:shadow-[0_20px_60px_rgb(0_0_0/40%)] backdrop-blur-xl"
          >
            <button
              type="button"
              onClick={() => setCheckinToast(null)}
              aria-label="关闭签到提示"
              className="absolute right-1 top-1 grid size-11 place-items-center rounded-full text-muted-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
            <div className="flex items-center gap-3 pr-6">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary">
                <Check className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-bold">签到成功</p>
                {checkinToast.map((line) => (
                  <p key={line} className="mt-1 text-xs leading-5 text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
            {checkinUpgradeCredits !== null ? (
              <div className="mt-4 border-t border-border/70 pt-3">
                <VipCheckinUpgrade
                  dailyCredits={checkinUpgradeCredits}
                  mainCredits={vipStatus.data?.benefits?.checkin_main_credits ?? 0}
                  onOpen={() => void openVip()}
                  pending={markVipSeen.isPending}
                />
                {vipError ? (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {vipError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function ProfileVipPlaceholder() {
  return (
    <div
      aria-label="正在准备 VIP 会员权益"
      className="min-h-[154px] animate-pulse rounded-[22px] border border-[#d8bca0]/15 bg-[linear-gradient(120deg,#332b2b,#272126_65%,#30262c)] px-5 py-4 motion-reduce:animate-none"
    >
      <div className="h-3 w-24 rounded-full bg-white/[0.06]" />
      <div className="mt-6 h-8 w-36 rounded-xl bg-white/[0.06]" />
      <div className="mt-5 h-3 w-48 rounded-full bg-white/[0.04]" />
    </div>
  );
}

function ProfileServicesFallback() {
  return (
    <section aria-label="服务与帮助" className="relative mt-6">
      <h2 className="mb-2.5 px-1 text-[11px] font-medium tracking-wider text-muted-foreground dark:text-[#a79da6]">
        服务与帮助
      </h2>
      <Link
        href="/profile/support"
        className="flex min-h-[76px] items-center gap-3 rounded-[20px] bg-surface-2 px-4 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:focus-visible:ring-[#d7b4bf]"
      >
        <span className="size-11 shrink-0 animate-pulse rounded-2xl bg-secondary dark:bg-white/[0.04] motion-reduce:animate-none" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">客服小助手</span>
          <span className="mt-1 block text-[11px] leading-5 text-muted-foreground dark:text-[#a89fa7]">
            遇到问题，来找我聊聊
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </section>
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
