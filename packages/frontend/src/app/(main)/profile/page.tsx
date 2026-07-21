'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Gift,
  Heart,
  History,
  ImageUp,
  Link as LinkIcon,
  Pencil,
  RotateCcw,
  Settings,
  ShoppingBag,
  Sparkles,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { AppearanceToggle } from '@/components/appearance-toggle';

import { useDailyCheckinMutation, useDailyCheckinQuery, useWalletCredits } from '@/lib/api/payment';
import {
  usePatchUserSettingsMutation,
  useSetUserAvatarMutation,
  useUserSettingsQuery,
} from '@/lib/api/settings';
import { getRawInitData } from '@/lib/telegram/auth';
import { formatNumber } from '@/lib/utils/payment';
import { useUserProfileStore } from '@/stores/user-profile-store';

export default function ProfilePage() {
  const telegramUserId = useMemo(readTelegramUserId, []);
  const credits = useWalletCredits();
  const displayName = useUserProfileStore((s) => s.displayName);
  const photoUrl = useUserProfileStore((s) => s.photoUrl);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  const userSettings = useUserSettingsQuery();
  const patchSettings = usePatchUserSettingsMutation();
  const setAvatar = useSetUserAvatarMutation();
  const checkinQ = useDailyCheckinQuery();
  const checkin = checkinQ.data?.checkin;
  const claimCheckin = useDailyCheckinMutation();

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [checkinToast, setCheckinToast] = useState<{ reward: number } | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
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
      className="app-page relative mx-auto flex w-full max-w-screen-xl flex-col pb-10 pt-[env(safe-area-inset-top)]"
    >
      {/* 顶部空间感 Banner */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.16),transparent_70%)]" />

      {/* 顶部 bar：左=合并 pill（星尘数 + 商店入口），右=签到 + 设置占位 */}
      <header className="relative z-10 flex items-center gap-2 px-3 py-3 sm:px-5">
        <div className="flex min-w-0 flex-1 basis-1/2 items-center gap-1.5">
          <Link
            href="/profile/recharge"
            aria-label={`当前星尘 ${credits}，前往星尘商店`}
            className="group inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1.5 text-xs backdrop-blur-md transition-all duration-300 hover:border-border hover:bg-muted sm:px-4 sm:py-2 sm:text-sm"
          >
            <Sparkles
              className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary drop-shadow-[0_0_8px_rgba(251,191,36,0.8)] transition-transform group-hover:scale-110"
              aria-hidden
            />
            <span className="truncate font-bold tracking-tight text-foreground">
              {formatNumber(credits)}
            </span>
            <span className="hidden text-muted-foreground sm:inline">·</span>
            <span className="hidden font-medium text-muted-foreground sm:inline">星尘商店</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </Link>
          <Link
            href="/profile/spending"
            aria-label="查看星尘消耗明细"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1.5 text-[11px] font-bold text-muted-foreground backdrop-blur-md transition-all hover:border-border hover:bg-muted hover:text-foreground sm:py-2"
          >
            <History className="h-3.5 w-3.5 text-primary" aria-hidden />
            明细
          </Link>
        </div>
        <div className="flex min-w-0 flex-1 basis-1/2 items-center justify-end gap-1">
          <Button
            disabled={!checkin?.can_claim || claimCheckin.isPending}
            onClick={() => void claimDailyCheckin()}
            size="sm"
            className="h-8 shrink-0 whitespace-nowrap rounded-full border border-primary/20 bg-primary/10 px-2 text-[11px] font-bold text-primary shadow-none hover:bg-primary/15 disabled:border-border disabled:bg-muted disabled:text-muted-foreground sm:h-9 sm:px-3 sm:text-xs"
            aria-label="每日签到"
          >
            <Gift className="mr-1 sm:mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {claimCheckin.isPending
              ? '领取中'
              : checkin?.can_claim
                ? `签到 +${checkin.reward_credits}`
                : '已签到'}
          </Button>
          <AppearanceToggle />
          <Button
            disabled
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-muted-foreground opacity-45 sm:size-9"
            aria-label="设置暂未开放"
          >
            <Settings className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden />
          </Button>
        </div>
      </header>

      {checkinToast && (
        <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[9999] flex justify-center px-5">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto relative w-full max-w-[320px] overflow-hidden rounded-[24px] border border-border bg-popover/75 px-5 py-4 text-left shadow-[0_24px_80px_rgba(0,0,0,0.45)] ring-1 ring-border backdrop-blur-xl"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,hsl(var(--primary)/0.3),transparent_54%)]" />
            <button
              type="button"
              onClick={() => setCheckinToast(null)}
              className="absolute right-3 top-3 z-10 rounded-full bg-muted p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              aria-label="关闭签到提示"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            <div className="relative flex items-center gap-3 pr-8">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-lg shadow-primary/15">
                <Gift className="h-6 w-6" aria-hidden />
              </div>
              <div>
                <p className="text-[10px] font-semibold tracking-[0.22em] text-primary">
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
            className="group relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          >
            <Avatar className="h-24 w-24 ring-4 ring-border ring-offset-4 ring-offset-background shadow-2xl transition group-hover:brightness-90">
              {photoUrl ? <AvatarImage src={photoUrl} alt={displayName} /> : null}
              <AvatarFallback className="bg-gradient-to-br from-emerald-700 via-emerald-500 to-teal-300 text-3xl font-black text-white">
                {displayName.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-lg transition group-hover:bg-primary/90">
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
              className="absolute left-1/2 top-[calc(100%+0.9rem)] z-30 w-max min-w-[220px] -translate-x-1/2 rounded-2xl border border-border bg-popover/95 p-2.5 shadow-[0_18px_60px_rgba(0,0,0,0.55)] ring-1 ring-border backdrop-blur-xl"
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
                  className="rounded-full border-border bg-muted text-foreground hover:bg-muted hover:text-foreground"
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
                  className="rounded-full border-border bg-muted text-foreground hover:bg-muted hover:text-foreground"
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
                  className="mt-1 w-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <RotateCcw aria-hidden />
                  恢复跟随 Telegram
                </Button>
              ) : null}
              {avatarError ? (
                <p
                  role="alert"
                  className="mt-2 max-w-[240px] px-2 text-center text-xs text-rose-300"
                >
                  {avatarError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
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
              className="h-10 w-56 border-border bg-muted text-center text-xl font-bold text-foreground focus-visible:ring-primary"
              aria-label="编辑显示名"
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={startEdit}
              className="group inline-flex h-auto items-center gap-1.5 px-3 py-1.5 text-xl font-bold text-foreground transition-all hover:bg-muted rounded-xl"
              aria-label="编辑显示名"
            >
              <span>{displayName}</span>
              <Pencil
                className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground/90"
                aria-hidden
              />
            </Button>
          )}
          <div className="mt-1 text-xs font-medium text-muted-foreground tracking-wider uppercase">
            ID · {telegramUserId ?? '未连接'}
          </div>
        </div>
      </section>

      <section className="relative z-10 mx-auto mt-8 grid w-full max-w-md grid-cols-2 gap-3 px-4">
        <ProfileLink href="/favorites" icon={<Heart />} label="收藏角色" />
        <ProfileLink href="/chats" icon={<History />} label="历史聊天" />
        <ProfileLink href="/profile/orders" icon={<ShoppingBag />} label="我的订单" />
      </section>
    </main>
  );
}

function ProfileLink(props: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={props.href}
      className="app-surface flex items-center gap-3 p-4 transition hover:border-primary/30 hover:shadow-md"
    >
      <span className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary [&_svg]:size-5">
        {props.icon}
      </span>
      <span className="font-semibold">{props.label}</span>
      <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
    </Link>
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
