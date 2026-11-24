'use client';

import Link from 'next/link';
import { Bell, Crown, Moon, Pencil, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ProfileAvatar } from '@/components/profile/profile-avatar';
import { Input } from '@/components/ui/input';
import { usePatchUserSettingsMutation } from '@/lib/api/settings';
import { useHaptic } from '@/lib/telegram';
import { useThemeStore } from '@/stores/theme-store';
import { useUserProfileStore } from '@/stores/user-profile-store';

const ICON_BUTTON =
  'relative grid size-11 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground transition hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/[0.04] dark:text-[#bcb2bb] dark:hover:bg-white/[0.08]';

/** 图标画的是点了之后会变成什么：夜间显示太阳，白天显示月亮。 */
function ThemeToggle() {
  const theme = useThemeStore((state) => state.theme);
  const toggle = useThemeStore((state) => state.toggle);
  const haptic = useHaptic();
  const Icon = theme === 'night' ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={theme === 'night' ? '切换到白天' : '切换到夜间'}
      onClick={() => {
        haptic.impact('light');
        toggle();
      }}
      className={ICON_BUTTON}
    >
      <Icon className="size-[18px]" aria-hidden />
    </button>
  );
}

export function ProfileHeader({
  userId,
  vipActive,
  hasUnread,
}: {
  userId: string | null;
  vipActive: boolean;
  hasUnread: boolean;
}) {
  const displayName = useUserProfileStore((s) => s.displayName);
  const photoUrl = useUserProfileStore((s) => s.photoUrl);
  const setDisplayName = useUserProfileStore((s) => s.setDisplayName);
  // 显示名和头像已有本地 profile store；只有打开头像菜单才需要读取服务端来源设置。
  const patchSettings = usePatchUserSettingsMutation();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const commit = () => {
    const next = draft.trim();
    setDisplayName(next);
    patchSettings.mutate({ display_name: next || null });
    setIsEditing(false);
  };

  return (
    <header className="relative z-20 flex items-center gap-3.5 px-1 pb-6">
      <ProfileAvatar displayName={displayName} photoUrl={photoUrl} vipActive={vipActive} />
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
                setIsEditing(false);
              }
            }}
            className="h-11 min-w-0 bg-card text-lg font-bold"
            aria-label="编辑显示名"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(displayName);
              setIsEditing(true);
            }}
            className="flex min-h-11 max-w-full items-center gap-2 rounded-lg text-left text-lg font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="编辑显示名"
          >
            <span className="truncate">{displayName || '设置昵称'}</span>
            <Pencil className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
          </button>
        )}
        <div className="flex min-w-0 items-center gap-2">
          {vipActive ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold text-primary">
              <Crown className="size-2.5" aria-hidden />
              VIP
            </span>
          ) : null}
          <p className="truncate text-[11px] tabular-nums text-muted-foreground">
            ID · {userId ?? '未连接'}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <Link
          href="/profile/messages"
          aria-label={`消息中心${hasUnread ? '，有未读消息' : ''}`}
          className={ICON_BUTTON}
        >
          <Bell className="size-[18px]" aria-hidden />
          {hasUnread ? (
            <span className="absolute right-2.5 top-2 size-2 rounded-full bg-rose ring-2 ring-background" />
          ) : null}
        </Link>
      </div>
    </header>
  );
}
