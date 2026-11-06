'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Gift, Send, type LucideIcon } from 'lucide-react';

import { useCommunityEntryQuery } from '@/lib/api/community';
import { useInviteEntryStatusQuery } from '@/lib/api/invite';
import { notificationKeys } from '@/lib/api/notifications';
import { paymentKeys } from '@/lib/api/payment';
import { useSupportUnreadQuery } from '@/lib/api/support';
import { formatNumber } from '@/lib/utils/payment';

import { useProfileServiceEntriesReady } from './profile-readiness';

const CommunitySheet = dynamic(
  () => import('./community-sheet').then((module) => module.CommunitySheet),
  { ssr: false }
);

export function ProfileServicesSection() {
  const queryClient = useQueryClient();
  const sectionRef = useRef<HTMLElement>(null);
  const entriesReady = useProfileServiceEntriesReady(sectionRef, true);
  const supportUnread = useSupportUnreadQuery({ poll: false, enabled: false });
  const inviteEntry = useInviteEntryStatusQuery({ enabled: entriesReady });
  const communityEntry = useCommunityEntryQuery({ enabled: entriesReady });
  const previousCommunityStatus = useRef(communityEntry.data?.claim_status);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [communitySheetMounted, setCommunitySheetMounted] = useState(false);

  useEffect(() => {
    const previous = previousCommunityStatus.current;
    const current = communityEntry.data?.claim_status;
    previousCommunityStatus.current = current;
    if (previous === 'unclaimed' && current === 'rewarded') {
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread });
    }
  }, [communityEntry.data?.claim_status, queryClient]);

  return (
    <>
      <section ref={sectionRef} aria-label="服务与帮助" className="relative mt-6">
        <h2 className="mb-2.5 px-1 text-[11px] font-medium tracking-wider text-[#a79da6]">
          服务与帮助
        </h2>
        <div className="overflow-hidden rounded-[20px] bg-[#222024]">
          <Link
            href="/profile/support"
            aria-label={supportUnread.data?.has_unread ? '联系客服，有新回复' : '联系客服'}
            className="group relative flex min-h-[76px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#d7b4bf]"
          >
            <SupportMascot />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">客服小助手</span>
              <span className="mt-1 block text-[11px] leading-5 text-[#a89fa7]">
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
            <section aria-label="更多服务" className="relative border-t border-white/[0.05]">
              <div className="divide-y divide-white/[0.05]">
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
                    onClick={() => {
                      setCommunitySheetMounted(true);
                      setCommunityOpen(true);
                    }}
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
        </div>
      </section>
      {communitySheetMounted && communityEntry.data ? (
        <CommunitySheet
          open={communityOpen}
          onOpenChange={setCommunityOpen}
          community={communityEntry.data}
        />
      ) : null}
    </>
  );
}

function SupportMascot() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 72 72"
      className="size-11 shrink-0 text-[#d6beca] transition-transform duration-200 motion-safe:group-hover:-rotate-3"
      fill="none"
    >
      <ellipse cx="36" cy="65" rx="20" ry="3" fill="#d6beca12" />
      <path d="M36 18V11" stroke="#d6beca" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="36" cy="8" r="3.5" fill="#d6beca" />
      <rect x="7" y="29" width="6" height="15" rx="3" fill="#d6beca80" />
      <rect x="59" y="29" width="6" height="15" rx="3" fill="#d6beca80" />
      <rect
        x="13"
        y="19"
        width="46"
        height="35"
        rx="15"
        fill="#d6beca22"
        stroke="#d6becaa6"
        strokeWidth="1.5"
      />
      <rect x="19" y="25" width="34" height="22" rx="9" fill="hsl(var(--background))" />
      <path d="M27 33V34M45 33V34" stroke="#d6beca" strokeWidth="4" strokeLinecap="round" />
      <path d="M32 39Q36 43 40 39" stroke="#d6beca" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="24" cy="39" rx="3" ry="1.8" fill="hsl(var(--rose) / 0.55)" />
      <ellipse cx="48" cy="39" rx="3" ry="1.8" fill="hsl(var(--rose) / 0.55)" />
      <path
        d="M26 55V60H46V55"
        stroke="#d6beca73"
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
  trailing,
}: {
  href?: string;
  onClick?: () => void;
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.03] text-[#b6a6b4]">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {trailing}
        <ChevronRight className="size-3.5 text-muted-foreground/70" aria-hidden />
      </span>
    </>
  );
  const className =
    'flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';
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
