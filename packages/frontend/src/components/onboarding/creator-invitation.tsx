'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { useOnboarding } from '@/hooks/use-onboarding';
import { lobbyViewerScope } from '@/lib/lobby-recommendation-state';
import {
  isBasicGuideFinished,
  isNewcomerProgress,
  useOnboardingStore,
} from '@/stores/onboarding-store';

/** A chat visit only arms a future invitation; it never interrupts the chat. */
export function useCreatorReturnVisit() {
  const scope = lobbyViewerScope();
  const expiresAt = useOnboardingStore((state) => state.accounts[scope]?.expiresAt);
  useEffect(() => {
    useOnboardingStore.getState().armCreatorReturn(scope);
  }, [scope, expiresAt]);
}

export function CreatorInvitation({ recommended }: { recommended: boolean }) {
  return <CreatorInvitationView key={lobbyViewerScope()} recommended={recommended} />;
}

function CreatorInvitationView({ recommended }: { recommended: boolean }) {
  const { scope, progress, hydrated, ready, update } = useOnboarding();
  const checked = useRef(false);
  const [returned, setReturned] = useState(false);
  const [visible, setVisible] = useState(false);
  const eligible =
    isNewcomerProgress(progress) && !progress?.creatorInvite && !progress?.creatorStarted;

  useEffect(() => {
    if (!hydrated || !progress || checked.current) return;
    checked.current = true;
    const fromChat = useOnboardingStore.getState().takeCreatorReturn(scope);
    // Finishing the return-to-chats hint on this visit must not immediately show another hint.
    setReturned(fromChat && isBasicGuideFinished(progress));
  }, [scope, hydrated, progress]);

  useEffect(() => {
    if (
      !ready ||
      !eligible ||
      !recommended ||
      !returned ||
      (progress?.completedTurns?.length ?? 0) < 10
    )
      return;
    update({ creatorInvite: 'shown' });
    setVisible(true);
  }, [ready, eligible, recommended, returned, progress?.completedTurns?.length, update]);

  if (!visible || !recommended) return null;
  return (
    <aside
      aria-label="角色创作邀请"
      className="fixed inset-x-4 bottom-[calc(var(--app-nav-space)+0.75rem)] z-40 mx-auto max-w-md rounded-2xl border border-primary/25 bg-card/95 shadow-[0_8px_32px_rgba(0,0,0,0.28)] backdrop-blur-xl"
    >
      <div className="flex items-start justify-between gap-1 pl-4">
        <p className="pt-3.5 text-[13px] font-medium">做自己的角色，还有创作福利</p>
        <button
          type="button"
          aria-label="收起创作邀请"
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground"
          onClick={() => {
            update({ creatorInvite: 'dismissed' });
            setVisible(false);
          }}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-2 divide-x divide-primary/15 px-4 pb-1">
        <div className="pr-3">
          <p className="text-xs text-muted-foreground">他人使用消耗星尘</p>
          <p className="mt-1 text-primary">
            <strong className="text-2xl font-semibold tabular-nums">40%</strong>
            <span className="ml-1 text-[11px]">专项星尘奖励</span>
          </p>
        </div>
        <div className="pl-4">
          <p className="text-xs text-muted-foreground">使用自己的角色</p>
          <p className="mt-1 text-primary">
            <strong className="text-2xl font-semibold tabular-nums">8 折</strong>
            <span className="ml-1 text-[11px]">全部模型</span>
          </p>
        </div>
      </div>
      <Link
        href="/creation/characters/new"
        onClick={() => update({ creatorInvite: 'accepted' })}
        className="mx-4 mb-2 mt-1 flex min-h-11 items-center justify-between rounded-lg text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        试着做一个
        <ArrowUpRight className="size-4" aria-hidden />
      </Link>
    </aside>
  );
}
