'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { GetGrowthPromptsData, GrowthPrompt } from '@miniapp/shared';

import { useCommunityEntryQuery } from '@/lib/api/community';
import { recordGrowthPromptEvent, useGrowthPromptsQuery } from '@/lib/api/growth-prompts';
import { notificationKeys } from '@/lib/api/notifications';
import { paymentKeys } from '@/lib/api/payment';
import { claimPromptSlot, isPromptSlotTaken, useRoundsThisVisit } from '@/lib/growth/prompt-visit';
import { useHaptic } from '@/lib/telegram';
import { openTelegramCommunity } from '@/lib/telegram/hooks';
import { formatNumber } from '@/lib/utils/payment';

import { GrowthPromptCard } from './growth-prompt-card';

/** 回复写完、换页或数据刚到之后，留一点空让用户看完再弹。 */
const SETTLE_MS = 1500;
const TOAST_MS = 2400;
const PROMPT_ROUTES = new Set(['/characters', '/chats', '/dramas', '/profile']);

function isPromptRoute(pathname: string): boolean {
  return PROMPT_ROUTES.has(pathname) || /^\/chat\/[^/]+$/.test(pathname);
}

/** 平静时刻：页面在前台、不在打字、没有别的弹层。 */
function isCalmMoment(pathname: string): boolean {
  if (document.visibilityState !== 'visible' || !isPromptRoute(pathname)) return false;
  if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return false;
  return !document.querySelector('[role="dialog"], [role="alertdialog"]');
}

export function pickGrowthPrompt(
  data: GetGrowthPromptsData,
  roundsThisVisit: number
): GrowthPrompt | null {
  const rounds = data.total_rounds + roundsThisVisit;
  return data.prompts.find((prompt) => rounds >= prompt.at_rounds) ?? null;
}

/**
 * 增长弹窗宿主：入口后台阶段之后才挂载，每次打开只取一次资格，之后按「服务端轮数 + 本次新完成的轮数」
 * 判断时机。同一次打开最多弹一个（与新人创作邀请共用一个位）。
 */
export function GrowthPromptHost() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { impact, notification } = useHaptic();
  const prompts = useGrowthPromptsQuery(true);
  const roundsThisVisit = useRoundsThisVisit();
  const [active, setActive] = useState<GrowthPrompt | null>(null);
  const [fallbackHandle, setFallbackHandle] = useState<string | null>(null);
  const [watchReward, setWatchReward] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!prompts.data || active || isPromptSlotTaken()) return;
    const candidate = pickGrowthPrompt(prompts.data, roundsThisVisit);
    if (!candidate) return;
    const timer = window.setTimeout(() => {
      if (!isCalmMoment(pathname) || !claimPromptSlot()) return;
      setActive(candidate);
      impact('light');
      void recordGrowthPromptEvent(candidate.kind, 'shown');
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [prompts.data, roundsThisVisit, pathname, active, impact]);

  const close = useCallback(() => {
    setActive(null);
    setFallbackHandle(null);
  }, []);

  const dismiss = useCallback(() => {
    if (active) void recordGrowthPromptEvent(active.kind, 'dismissed');
    close();
  }, [active, close]);

  const accept = useCallback(() => {
    if (!active) return;
    void recordGrowthPromptEvent(active.kind, 'accepted');
    if (active.kind === 'vip') {
      close();
      const returnTo = `${window.location.pathname}${window.location.search}`;
      router.push(`/vip?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!openTelegramCommunity(active.telegram_url)) {
      setFallbackHandle(active.fallback_handle);
      return;
    }
    close();
    setWatchReward(true);
  }, [active, close, router]);

  const onRewarded = useCallback(
    (credits: number) => {
      setWatchReward(false);
      notification('success');
      setToast(`${formatNumber(credits)} 星尘已到账`);
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
    },
    [notification, queryClient]
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <>
      {active ? (
        <GrowthPromptCard
          prompt={active}
          fallbackHandle={fallbackHandle}
          onAccept={accept}
          onDismiss={dismiss}
        />
      ) : null}
      {watchReward ? <CommunityRewardWatcher onRewarded={onRewarded} /> : null}
      <RewardToast message={toast} />
    </>
  );
}

/**
 * 点了进群之后才启用社群入口查询：未领奖时它每 15 秒、以及回到前台时刷新，
 * 用户在群里点完「加入」回来，很快就能看到到账提示。
 */
function CommunityRewardWatcher({ onRewarded }: { onRewarded: (credits: number) => void }) {
  const entry = useCommunityEntryQuery({ enabled: true });
  const status = entry.data?.claim_status;
  const credits = entry.data?.reward_credits ?? 0;
  // 进群卡只发给未领奖的人，所以这里看到 rewarded 就是刚到账。
  useEffect(() => {
    if (status === 'rewarded') onRewarded(credits);
  }, [status, credits, onRewarded]);
  return null;
}

function RewardToast({ message }: { message: string | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[60] -translate-x-1/2 whitespace-nowrap rounded-full border border-[#d9b48a]/45 bg-[#2b241f] px-[18px] py-2.5 text-sm font-semibold text-[#f0d3a8] shadow-[0_10px_30px_rgba(0,0,0,0.5)] transition-[opacity,transform] duration-300 ${
        message ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0'
      }`}
    >
      {message ? `✦ ${message}` : null}
    </div>
  );
}
