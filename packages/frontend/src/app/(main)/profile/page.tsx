'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Bell,
  Check,
  Gem,
  Gift,
  Headphones,
  ImageUp,
  Link as LinkIcon,
  Pencil,
  RotateCcw,
  ReceiptText,
  Sparkles,
  Send,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';

import {
  paymentKeys,
  useDailyCheckinMutation,
  useDailyCheckinQuery,
  useWalletCredits,
} from '@/lib/api/payment';
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
import { getRawInitData } from '@/lib/telegram/auth';
import { formatNumber } from '@/lib/utils/payment';
import { useUserProfileStore } from '@/stores/user-profile-store';

export default function ProfilePage() {
  const queryClient = useQueryClient();
  const telegramUserId = useMemo(readTelegramUserId, []);
  const credits = useWalletCredits();
  const unread = useNotificationUnreadCountQuery();
  const supportUnread = useSupportUnreadQuery();
  const displayName = useUserProfileStore((s) => s.displayName);
  const photoUrl = useUserProfileStore((s) => s.photoUrl);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  const userSettings = useUserSettingsQuery();
  const patchSettings = usePatchUserSettingsMutation();
  const setAvatar = useSetUserAvatarMutation();
  const checkinQ = useDailyCheckinQuery();
  const checkin = checkinQ.data?.checkin;
  const claimCheckin = useDailyCheckinMutation();
  const inviteEntry = useInviteEntryStatusQuery();
  const communityEntry = useCommunityEntryQuery();
  const previousCommunityStatus = useRef(communityEntry.data?.claim_status);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [checkinToast, setCheckinToast] = useState<{ reward: number } | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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
    const timer = window.setTimeout(() => setCheckinToast(null), 1500);
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
    try {
      const data = await claimCheckin.mutateAsync();
      setCheckinToast({ reward: data.checkin.reward_credits });
    } catch {
      // Mutation state already carries the error; keep the click handler quiet.
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

  return (
    <main
      data-app-shell="profile"
      className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col bg-background pb-10 pt-[env(safe-area-inset-top)] relative"
    >
      {/* 顶部空间感 Banner：烛光自顶部渗下，避免深夜使用时出现冷光 */}
      <div className="absolute top-0 left-0 right-0 h-48 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.16),hsl(var(--rose)/0.06),transparent_70%)] pointer-events-none" />

      {/* 右上角原有齿轮入口已下线，这里留空 */}
      <div className="h-3" />

      {checkinToast && (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[9999] flex justify-center px-5">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative w-full max-w-[320px] overflow-hidden rounded-[24px] border border-border bg-card/95 px-5 py-4 text-left shadow-[0_24px_80px_rgba(0,0,0,0.45)] ring-1 ring-primary/10 backdrop-blur-xl"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,hsl(var(--primary)/0.28),transparent_54%)]" />
            <button
              type="button"
              onClick={() => setCheckinToast(null)}
              className="absolute right-3 top-3 z-10 rounded-full bg-secondary p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="关闭签到提示"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            <div className="relative flex items-center gap-3 pr-8">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/25 bg-primary/15 text-primary shadow-[0_0_40px_hsl(var(--glow)/0.35)]">
                <Gift className="h-6 w-6" aria-hidden />
              </div>
              <div>
                <p className="text-[10px] font-semibold tracking-[0.22em] text-primary/70">
                  DAILY CHECK-IN
                </p>
                <h2 className="mt-1 text-base font-black tracking-tight text-foreground">
                  签到成功
                </h2>
                <p className="mt-1 text-sm font-medium text-muted-foreground">
                  星尘 +{checkinToast.reward} 已到账。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 身份：页面重心；姓名可点击编辑 */}
      <section className="mt-8 flex flex-col items-center gap-4 px-5 relative z-10">
        <div ref={avatarMenuRef} className="relative">
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
            <Avatar className="h-24 w-24 ring-4 ring-border ring-offset-4 ring-offset-background shadow-2xl transition group-hover:brightness-90">
              {photoUrl ? <AvatarImage src={photoUrl} alt={displayName} /> : null}
              <AvatarFallback className="bg-gradient-to-br from-primary via-rose to-rose-fill text-3xl font-black text-primary-foreground">
                {displayName.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-lg transition group-hover:brightness-110">
              <ImageUp className="h-3.5 w-3.5" aria-hidden />
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
              className="absolute left-1/2 top-[calc(100%+0.9rem)] z-30 w-max min-w-[220px] -translate-x-1/2 rounded-2xl border border-border bg-popover/95 p-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.55)] ring-1 ring-primary/5 backdrop-blur-xl"
            >
              <span className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-border bg-popover" />
              <div className="relative flex items-center justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  role="menuitem"
                  disabled={setAvatar.isPending}
                  onClick={() => avatarInputRef.current?.click()}
                  className="rounded-full border-border bg-card text-foreground hover:bg-secondary hover:text-foreground"
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
                  className="rounded-full border-border bg-card text-foreground hover:bg-secondary hover:text-foreground"
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
                  className="mt-1 w-full rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
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

        {/* 签到刻意做成低对比轻量样式，不与下方星尘卡抢视觉层级 */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!checkin?.can_claim || claimCheckin.isPending}
          onClick={() => void claimDailyCheckin()}
          aria-label="每日签到"
          className="h-8 rounded-full border border-border bg-card/70 px-3.5 text-[12px] font-semibold text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground disabled:opacity-100"
        >
          {checkin?.can_claim ? (
            <Gift className="mr-1.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {claimCheckin.isPending
            ? '领取中'
            : checkin?.can_claim
              ? `签到 · +${formatNumber(checkin.reward_credits)}`
              : '今日已签到'}
        </Button>

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
              className="h-10 w-56 text-center text-xl font-bold bg-card border-border text-foreground focus-visible:ring-ring"
              aria-label="编辑显示名"
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={startEdit}
              className="group inline-flex h-auto items-center gap-1.5 px-3 py-1.5 text-xl font-bold text-foreground transition-all hover:bg-secondary rounded-xl"
              aria-label="编辑显示名"
            >
              <span>{displayName}</span>
              <Pencil
                className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground"
                aria-hidden
              />
            </Button>
          )}
          <div className="mt-1 text-xs font-medium text-muted-foreground tracking-wider uppercase">
            ID · {telegramUserId ?? '未连接'}
          </div>
        </div>
      </section>

      {/* 星尘余额：首屏最强视觉层级，只讲余额和充值，不出现会员信息 */}
      <section className="relative z-10 mt-7 px-5">
        <div className="relative overflow-hidden rounded-[26px] border border-primary/20 bg-card p-5 shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 -top-16 h-44 w-44 rounded-full bg-[radial-gradient(circle,hsl(var(--glow)/0.28),transparent_68%)]"
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground">
                星尘余额
              </p>
              <p className="mt-2 flex items-baseline gap-1.5">
                <span className="text-[34px] font-black leading-none tabular-nums tracking-tight text-foreground">
                  {formatNumber(credits)}
                </span>
                <span className="text-xs font-medium text-muted-foreground">星尘</span>
              </p>
            </div>
            <Link
              href="/profile/recharge"
              aria-label="前往星尘充值"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-3 py-1.5 text-[12px] font-bold text-primary transition hover:bg-primary/25"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              星尘充值
            </Link>
          </div>
        </div>
      </section>

      {/* 邀请中心：裂变优先入口，位于余额卡与常规列表之间（PRD：星尘余额下方）。
          显隐由运营总开关控制；"2200星尘"提醒标签在首次进入邀请中心后由服务端字段翻转消失 */}
      {inviteEntry.data?.entry_enabled ? (
        <section className="relative z-10 mt-4 px-5">
          <Link
            href="/profile/invite"
            className="relative flex items-center gap-3.5 overflow-hidden rounded-[22px] border border-border bg-card px-4 py-3.5 transition hover:border-primary/25 hover:bg-secondary"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Gem className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[15px] font-bold tracking-tight text-foreground">
                  邀请中心
                </span>
                {inviteEntry.data.center_entered ? null : (
                  <span className="shrink-0 rounded-full bg-gradient-to-r from-rose to-rose-fill px-2 py-0.5 text-[10px] font-black italic text-primary-foreground shadow-sm">
                    2200星尘
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                分享专属链接，邀请好友得2200星尘
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[12px] font-bold text-primary">
              去邀请
              <ChevronRight className="h-4 w-4" aria-hidden />
            </span>
          </Link>
        </section>
      ) : null}

      <section className="relative z-10 mt-4 flex flex-col gap-2.5 px-5">
        <ProfileRow
          href="/profile/support"
          Icon={Headphones}
          title="联系客服"
          subtitle="有问题随时找我们"
          showDot={supportUnread.data?.has_unread === true}
        />
        <ProfileRow
          href="/profile/messages"
          Icon={Bell}
          title="消息中心"
          subtitle="官方公告与系统消息"
          showDot={(unread.data?.total ?? 0) > 0}
        />
        {communityEntry.data?.enabled ? (
          <ProfileRow
            onClick={() => setCommunityOpen(true)}
            Icon={Send}
            title="官方社群"
            subtitle="加入秘境官方社群，与大家一起交流。"
            // iconClassName="bg-sky-500/15 text-sky-400"
            trailing={
              <span className="flex items-center gap-1 text-xs font-bold text-amber-400">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {communityEntry.data.reward_credits} 星尘
                <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
              </span>
            }
          />
        ) : null}
        <ProfileRow
          href="/profile/spending"
          Icon={ReceiptText}
          title="消费明细"
          subtitle="星尘消费支出记录"
        />
      </section>
      {communityEntry.data ? (
        <CommunitySheet
          open={communityOpen}
          onOpenChange={setCommunityOpen}
          community={communityEntry.data}
        />
      ) : null}
    </main>
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
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${iconClassName ?? 'bg-primary/10 text-primary'}`}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-bold tracking-tight text-foreground">
          {title}
        </span>
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
        {!trailing ? <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden /> : null}
      </span>
    </>
  );
  const className =
    'flex w-full items-center gap-3.5 rounded-[22px] border border-border bg-card px-4 py-3.5 text-left transition hover:border-primary/25 hover:bg-secondary';
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
