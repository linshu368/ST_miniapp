'use client';

import Link from 'next/link';
import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { usePageReady } from '@/lib/perf/page-ready';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  ArrowUpRight,
  Loader2,
  Bell,
  Crown,
  Check,
  Gem,
  Gift,
  ImageUp,
  Link as LinkIcon,
  Pencil,
  RotateCcw,
  Send,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { VipEntryCard } from '@/components/vip/vip-entry-card';

import {
  paymentKeys,
  useDailyCheckinMutation,
  useDailyCheckinQuery,
  useWalletBalanceQuery,
  usePaymentPlansQuery,
} from '@/lib/api/payment';
import { useMarkVipEntryViewedMutation, useVipStatusQuery } from '@/lib/api/vip';
import { useInviteEntryStatusQuery } from '@/lib/api/invite';
import { notificationKeys, useNotificationUnreadCountQuery } from '@/lib/api/notifications';
import { useSupportUnreadQuery } from '@/lib/api/support';
import { useCommunityEntryQuery } from '@/lib/api/community';
import { CommunitySheet } from '@/components/profile/community-sheet';
import {
  usePatchUserSettingsMutation,
  useSetUserAvatarMutation,
  useUserSettingsQuery,
} from '@/lib/api/settings';
import { captureRechargeEntryClicked } from '@/lib/payment/flow-telemetry';
import { getRawInitData } from '@/lib/telegram/auth';
import { formatNumber } from '@/lib/utils/payment';
import { checkinRewardLines } from '@/lib/vip/presentation';
import { useUserProfileStore } from '@/stores/user-profile-store';

export default function ProfilePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const telegramUserId = useMemo(readTelegramUserId, []);
  const wallet = useWalletBalanceQuery();
  usePageReady('/profile', wallet.data !== undefined);
  const credits = wallet.data?.total_credits ?? wallet.data?.credits;
  const bonusCredits = wallet.data?.bonus_credits;
  // BottomNav 同屏常驻并负责轮询，这里只订阅缓存，避免同一端点两个 interval 各打一份。
  const unread = useNotificationUnreadCountQuery({ poll: false });
  const supportUnread = useSupportUnreadQuery({ poll: false });
  const displayName = useUserProfileStore((s) => s.displayName);
  const photoUrl = useUserProfileStore((s) => s.photoUrl);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  const userSettings = useUserSettingsQuery();
  const patchSettings = usePatchUserSettingsMutation();
  const setAvatar = useSetUserAvatarMutation();
  const checkinQ = useDailyCheckinQuery();
  const checkin = checkinQ.data?.checkin;
  const claimCheckin = useDailyCheckinMutation();
  const vipStatus = useVipStatusQuery();
  const paymentPlans = usePaymentPlansQuery();
  const markVipSeen = useMarkVipEntryViewedMutation();
  const inviteEntry = useInviteEntryStatusQuery();
  const communityEntry = useCommunityEntryQuery();
  const previousCommunityStatus = useRef(communityEntry.data?.claim_status);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [checkinToast, setCheckinToast] = useState<string[] | null>(null);
  const [vipError, setVipError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openingVip = useRef(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!checkinToast) return;
    const timer = window.setTimeout(
      () => setCheckinToast(null),
      checkinToast.length > 1 ? 3200 : 1500
    );
    return () => window.clearTimeout(timer);
  }, [checkinToast]);

  useEffect(() => {
    const previous = previousCommunityStatus.current;
    const current = communityEntry.data?.claim_status;
    previousCommunityStatus.current = current;
    if (previous === 'unclaimed' && current === 'rewarded') {
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
    }
  }, [communityEntry.data?.claim_status, queryClient]);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!avatarMenuRef.current?.contains(event.target as Node)) setAvatarMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAvatarMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [avatarMenuOpen]);

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

  const importAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    setAvatarError(null);
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
      }
      if (file.size > 2 * 1024 * 1024) throw new Error('头像文件不能超过 2MB');
      const dataBase64 = await readFileAsBase64(file);
      await setAvatar.mutateAsync({
        source: 'upload',
        content_type: file.type,
        data_base64: dataBase64,
      });
      setAvatarMenuOpen(false);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : '头像上传失败');
    } finally {
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const importAvatarUrl = async () => {
    const url = window.prompt('粘贴 HTTPS 图片链接（PNG、JPEG 或 WebP，最大 2MB）');
    if (!url?.trim()) return;
    setAvatarError(null);
    try {
      await setAvatar.mutateAsync({ source: 'url', url: url.trim() });
      setAvatarMenuOpen(false);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : '头像导入失败');
    }
  };

  const resetAvatar = async () => {
    setAvatarError(null);
    try {
      await patchSettings.mutateAsync({ avatar_url: null });
      setAvatarMenuOpen(false);
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : '恢复默认头像失败');
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
      setVipError('暂时无法打开 VIP，请重试');
    } finally {
      openingVip.current = false;
    }
  };

  const checkinReadFailed = checkinQ.isError && !checkin;
  const hasClaimed = checkin?.can_claim === false;

  return (
    <main
      data-app-shell="profile"
      className="relative mx-auto min-h-[calc(100dvh-5.5rem)] w-full max-w-lg bg-background px-4 pb-5 pt-[calc(env(safe-area-inset-top)+1rem)]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[radial-gradient(ellipse_at_top_left,hsl(var(--primary)/0.1),transparent_70%)]"
      />

      <header className="relative z-20 flex items-center gap-3 px-1 pb-5">
        <div ref={avatarMenuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setAvatarError(null);
              setAvatarMenuOpen((open) => !open);
            }}
            aria-label="更换头像"
            aria-expanded={avatarMenuOpen}
            aria-haspopup="menu"
            className="group relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          >
            <Avatar
              className={`size-16 ring-2 ring-offset-2 ring-offset-background transition group-hover:brightness-90 ${vipStatus.data?.active ? 'ring-primary/70 shadow-[0_0_20px_hsl(var(--glow)/0.15)]' : 'ring-border'}`}
            >
              {photoUrl ? <AvatarImage src={photoUrl} alt={displayName} /> : null}
              <AvatarFallback className="bg-gradient-to-br from-primary via-rose to-rose-fill text-2xl font-black text-primary-foreground">
                {displayName.slice(0, 1).toUpperCase() || '我'}
              </AvatarFallback>
            </Avatar>
            <span className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border-2 border-background bg-secondary text-foreground">
              <Pencil className="size-2.5" aria-hidden />
            </span>
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => void importAvatarFile(event.target.files?.[0])}
          />
          {avatarMenuOpen ? (
            <div
              role="menu"
              className="absolute left-0 top-[calc(100%+0.9rem)] z-30 w-max min-w-[220px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-border bg-popover/95 p-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.55)] ring-1 ring-primary/5 backdrop-blur-xl"
            >
              <span className="absolute -top-1.5 left-6 size-3 rotate-45 border-l border-t border-border bg-popover" />
              <div className="relative flex items-center justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  role="menuitem"
                  disabled={setAvatar.isPending}
                  onClick={() => avatarInputRef.current?.click()}
                  className="min-h-11 rounded-full border-border bg-card text-foreground hover:bg-secondary hover:text-foreground"
                >
                  <ImageUp aria-hidden />
                  上传图片
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  role="menuitem"
                  disabled={setAvatar.isPending}
                  onClick={() => void importAvatarUrl()}
                  className="min-h-11 rounded-full border-border bg-card text-foreground hover:bg-secondary hover:text-foreground"
                >
                  <LinkIcon aria-hidden />
                  导入链接
                </Button>
              </div>
              {userSettings.data?.settings.avatar_source === 'custom' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  role="menuitem"
                  disabled={patchSettings.isPending}
                  onClick={() => void resetAvatar()}
                  className="mt-1 min-h-11 w-full rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <RotateCcw aria-hidden />
                  恢复跟随 Telegram
                </Button>
              ) : null}
              {avatarError ? (
                <p
                  role="alert"
                  className="mt-2 max-w-[240px] px-2 text-center text-xs text-destructive"
                >
                  {avatarError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <Input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={32}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancel();
                }
              }}
              className="h-11 min-w-0 bg-card text-lg font-bold"
              aria-label="编辑显示名"
            />
          ) : (
            <button
              type="button"
              onClick={startEdit}
              className="flex min-h-11 max-w-full items-center gap-2 rounded-lg text-left text-lg font-bold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="编辑显示名"
            >
              <span className="truncate">{displayName || '设置昵称'}</span>
              <Pencil className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
            </button>
          )}
          <div className="flex min-w-0 items-center gap-2">
            {vipStatus.data?.active ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold text-primary">
                <Crown className="size-2.5" aria-hidden />
                VIP
              </span>
            ) : null}
            <p className="truncate text-[11px] tabular-nums text-muted-foreground">
              ID · {telegramUserId ?? '未连接'}
            </p>
          </div>
        </div>
        <Link
          href="/profile/messages"
          aria-label={`消息中心${(unread.data?.total ?? 0) > 0 ? '，有未读消息' : ''}`}
          className="relative grid size-11 shrink-0 place-items-center rounded-full border border-border/70 bg-card/70 text-muted-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bell className="size-[18px]" aria-hidden />
          {(unread.data?.total ?? 0) > 0 ? (
            <span className="absolute right-2.5 top-2 size-2 rounded-full bg-rose ring-2 ring-background" />
          ) : null}
        </Link>
      </header>

      <section
        aria-label="每日签到"
        className={`relative overflow-hidden rounded-[24px] border p-4 ${hasClaimed ? 'border-border bg-card/60' : 'border-primary/25 bg-[linear-gradient(115deg,hsl(var(--primary)/0.15),hsl(var(--card))_75%)]'}`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`grid size-11 shrink-0 place-items-center rounded-2xl ${hasClaimed ? 'bg-secondary text-muted-foreground' : 'bg-primary/15 text-primary'}`}
          >
            {hasClaimed ? (
              <Check className="size-5" aria-hidden />
            ) : (
              <Gift className="size-5" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-bold">每日签到</h1>
            <p
              className="mt-1 text-xs leading-5 text-muted-foreground"
              role={!checkin ? 'status' : undefined}
            >
              {checkinReadFailed ? (
                '暂时无法确认签到状态'
              ) : !checkin ? (
                '正在查看今日奖励…'
              ) : hasClaimed ? (
                '今日星尘已领取'
              ) : (
                <>
                  <span className="font-bold tabular-nums text-primary">
                    +{formatNumber(checkin.reward_credits)}
                  </span>{' '}
                  星尘待领取
                </>
              )}
            </p>
          </div>
          <Button
            type="button"
            disabled={
              claimCheckin.isPending ||
              (!checkin?.can_claim && !checkinReadFailed) ||
              (checkinReadFailed && checkinQ.isFetching)
            }
            onClick={() => (checkinReadFailed ? void checkinQ.refetch() : void claimDailyCheckin())}
            aria-label={checkinReadFailed ? '重试加载签到' : '每日签到'}
            className={`min-h-11 shrink-0 rounded-full px-4 text-xs font-bold shadow-none ${hasClaimed ? 'bg-secondary text-muted-foreground disabled:opacity-100' : ''}`}
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
      </section>

      <section
        aria-label="我的星尘"
        className="relative mt-3 overflow-hidden rounded-[26px] border border-border bg-card px-5 pb-2 pt-5"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-12 size-40 rounded-full bg-[radial-gradient(circle,hsl(var(--glow)/0.12),transparent_70%)]"
        />
        <div className="relative flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Gem className="size-3.5" aria-hidden />
              星尘余额
            </p>
            <p className="mt-2 flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[34px] font-bold leading-none tabular-nums tracking-tight">
                {typeof credits === 'number' ? formatNumber(credits) : '—'}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">星尘</span>
            </p>
          </div>
          <Link
            href="/profile/recharge"
            aria-label="前往星尘充值"
            onClick={() => captureRechargeEntryClicked({ telegramUserId })}
            className="relative inline-flex min-h-12 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-bold text-primary-foreground shadow-[0_6px_22px_hsl(var(--glow)/0.14)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            充值星尘
            <ArrowUpRight className="size-4" aria-hidden />
          </Link>
        </div>
        <div className="relative mt-1 flex min-h-11 items-center justify-between gap-2">
          {wallet.isError ? (
            <button
              type="button"
              onClick={() => void wallet.refetch()}
              disabled={wallet.isFetching}
              className="min-h-11 text-left text-[11px] text-destructive disabled:opacity-60"
            >
              {wallet.isFetching ? '正在重试…' : '余额加载失败，重试'}
            </button>
          ) : (
            <p className="min-w-0 truncate text-[11px] text-muted-foreground">
              {typeof bonusCredits === 'number'
                ? `内含专项星尘 ${formatNumber(bonusCredits)}`
                : '正在读取余额…'}
            </p>
          )}
          <Link
            href="/profile/spending"
            className="inline-flex min-h-11 shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/80 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            消费明细
            <ChevronRight className="size-3" aria-hidden />
          </Link>
        </div>
      </section>

      <section aria-label="VIP 会员权益" className="relative mt-3">
        <VipEntryCard
          status={vipStatus.data}
          monthlyPlan={paymentPlans.data?.vip_plans?.find((plan) => plan.id === 'month')}
          loading={vipStatus.isLoading || paymentPlans.isLoading}
          disabled={markVipSeen.isPending}
          onOpen={() => void openVip()}
        />
        {vipStatus.isError ? (
          <p className="px-4 pt-2 text-[11px] text-muted-foreground">会员状态暂时无法确认</p>
        ) : null}
        {vipError ? (
          <p role="alert" className="px-4 pt-2 text-xs text-destructive">
            {vipError}
          </p>
        ) : null}
      </section>

      <Link
        href="/profile/support"
        aria-label={supportUnread.data?.has_unread ? '联系客服，有新回复' : '联系客服'}
        className="group relative mt-4 flex min-h-24 items-center gap-3 overflow-hidden rounded-[24px] border border-border/70 bg-[linear-gradient(110deg,hsl(var(--rose)/0.08),hsl(var(--card))_75%)] px-4 py-3 transition hover:border-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SupportMascot />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold">客服小助手</span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            {supportUnread.data?.has_unread ? '有新回复，点这里查看' : '遇到问题，来找我聊聊'}
          </span>
        </span>
        {supportUnread.data?.has_unread ? (
          <span className="size-2 shrink-0 rounded-full bg-rose" aria-hidden />
        ) : null}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>

      {inviteEntry.data?.entry_enabled ||
      (communityEntry.data?.enabled && communityEntry.data.claim_status !== 'rewarded') ? (
        <section aria-label="更多服务" className="relative mt-5">
          <h2 className="mb-2 px-1 text-[11px] font-medium tracking-wide text-muted-foreground">
            更多服务
          </h2>
          <div className="divide-y divide-border/60 overflow-hidden rounded-[24px] border border-border/70 bg-card/60">
            {inviteEntry.data?.entry_enabled ? (
              <ProfileRow
                href="/profile/invite"
                Icon={Gift}
                title="邀请有礼"
                subtitle="和朋友一起探索秘境"
                trailing={
                  !inviteEntry.data.center_entered ? (
                    <span className="text-[11px] font-medium tabular-nums text-primary">
                      2200 星尘
                    </span>
                  ) : undefined
                }
              />
            ) : null}
            {communityEntry.data?.enabled && communityEntry.data.claim_status !== 'rewarded' ? (
              <ProfileRow
                onClick={() => setCommunityOpen(true)}
                Icon={Send}
                title="官方社群"
                subtitle="加入社群，和大家交流玩法"
                trailing={
                  communityEntry.data.claim_status === 'unclaimed' ||
                  communityEntry.data.claim_status === 'existing_member' ? (
                    <span className="text-[11px] font-medium tabular-nums text-primary">
                      {formatNumber(communityEntry.data.reward_credits)} 星尘
                    </span>
                  ) : undefined
                }
              />
            ) : null}
          </div>
        </section>
      ) : null}
      {communityEntry.data ? (
        <CommunitySheet
          open={communityOpen}
          onOpenChange={setCommunityOpen}
          community={communityEntry.data}
        />
      ) : null}

      {checkinToast ? (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[9999] flex justify-center px-5">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative w-full max-w-[320px] rounded-[24px] border border-primary/25 bg-card/95 px-5 py-4 shadow-[0_20px_60px_rgb(0_0_0/40%)] backdrop-blur-xl"
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
          </div>
        </div>
      ) : null}
    </main>
  );
}

function SupportMascot() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 72 72"
      className="size-16 shrink-0 transition-transform duration-200 motion-safe:group-hover:-rotate-3"
      fill="none"
    >
      <ellipse cx="36" cy="65" rx="20" ry="3" fill="hsl(var(--primary) / 0.1)" />
      <path d="M36 18V11" stroke="hsl(var(--primary))" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="36" cy="8" r="3.5" fill="hsl(var(--primary))" />
      <rect x="7" y="29" width="6" height="15" rx="3" fill="hsl(var(--primary) / 0.5)" />
      <rect x="59" y="29" width="6" height="15" rx="3" fill="hsl(var(--primary) / 0.5)" />
      <rect
        x="13"
        y="19"
        width="46"
        height="35"
        rx="15"
        fill="hsl(var(--primary) / 0.2)"
        stroke="hsl(var(--primary) / 0.65)"
        strokeWidth="1.5"
      />
      <rect x="19" y="25" width="34" height="22" rx="9" fill="hsl(var(--background))" />
      <path
        d="M27 33V34M45 33V34"
        stroke="hsl(var(--primary))"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M32 39Q36 43 40 39"
        stroke="hsl(var(--primary))"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <ellipse cx="24" cy="39" rx="3" ry="1.8" fill="hsl(var(--rose) / 0.55)" />
      <ellipse cx="48" cy="39" rx="3" ry="1.8" fill="hsl(var(--rose) / 0.55)" />
      <path
        d="M26 55V60H46V55"
        stroke="hsl(var(--primary) / 0.45)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M54 13H60M57 10V16"
        stroke="hsl(var(--rose) / 0.75)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProfileRow({
  href,
  onClick,
  Icon,
  title,
  subtitle,
  showDot = false,
  iconClassName,
  trailing,
}: {
  href?: string;
  onClick?: () => void;
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  showDot?: boolean;
  iconClassName?: string;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${iconClassName ?? 'bg-secondary text-muted-foreground'}`}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {trailing}
        {showDot ? (
          <span
            role="status"
            aria-label="有未读消息"
            className="h-2 w-2 rounded-full bg-destructive"
          />
        ) : null}
        <ChevronRight className="size-3.5 text-muted-foreground/70" aria-hidden />
      </span>
    </>
  );
  const className =
    'flex min-h-[74px] w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';
  return href ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取头像文件失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const separator = result.indexOf(',');
      if (separator < 0) {
        reject(new Error('读取头像文件失败'));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
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
