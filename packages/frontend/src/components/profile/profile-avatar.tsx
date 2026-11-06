'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

const ProfileAvatarMenu = dynamic(
  () => import('./profile-avatar-menu').then((module) => ({ default: module.ProfileAvatarMenu })),
  { ssr: false }
);

export function ProfileAvatar({
  displayName,
  photoUrl,
  vipActive,
}: {
  displayName: string;
  photoUrl: string | null | undefined;
  vipActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="更换头像"
        aria-expanded={open}
        aria-haspopup="menu"
        className="group relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      >
        <Avatar
          className={`size-14 ring-1 ring-offset-[3px] ring-offset-[#19171a] transition group-hover:brightness-90 ${vipActive ? 'ring-[#d5b99d]/65' : 'ring-white/15'}`}
        >
          {photoUrl ? <AvatarImage src={photoUrl} alt={displayName} /> : null}
          <AvatarFallback className="bg-[#3c303a] text-xl font-medium text-[#e5cbd5]">
            {displayName.slice(0, 1).toUpperCase() || '我'}
          </AvatarFallback>
        </Avatar>
        <span className="absolute -bottom-0.5 -right-0.5 grid size-6 place-items-center rounded-full border-2 border-background bg-secondary text-foreground">
          <Pencil className="size-2.5" aria-hidden />
        </span>
      </button>
      {open ? <ProfileAvatarMenu onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
