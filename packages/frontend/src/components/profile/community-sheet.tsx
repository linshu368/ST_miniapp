'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Loader2, Send } from 'lucide-react';
import type { CommunityEntryData } from '@miniapp/shared';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useVerifyCommunityMembershipMutation } from '@/lib/api/community';
import { openTelegramCommunity } from '@/lib/telegram/hooks';

export function CommunitySheet({
  open,
  onOpenChange,
  community,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  community: CommunityEntryData;
}) {
  const verify = useVerifyCommunityMembershipMutation();
  // const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const status = verify.data?.status;
  const rewarded =
    community.claim_status === 'rewarded' || status === 'rewarded' || status === 'already_rewarded';
  const ineligible = community.claim_status === 'ineligible' || status === 'ineligible';
  const canManuallyVerify = community.claim_status === 'existing_member';
  const message =
    community.claim_status === 'ineligible' || status === 'ineligible'
      ? '本奖励仅面向活动上线后新加入的成员。'
      : status === 'disabled'
        ? '活动当前未开放，暂时无法领取奖励。'
        : status === 'pending'
          ? '入群申请仍在等待审批，请通过后再验证。'
          : status === 'not_member'
            ? '尚未检测到入群，请完成加入后重试。'
            : verify.isError
              ? '验证暂时失败，请稍后重试。'
              : null;
  useEffect(() => {
    if (!open) {
      setOpenFailed(false);
      setCopyFailed(false);
    }
  }, [open]);
  // const copyHandle = async () => {
  //   try {
  //     await navigator.clipboard.writeText(community.fallback_handle);
  //     setCopyFailed(false);
  //     setCopied(true);
  //     window.setTimeout(() => setCopied(false), 1500);
  //   } catch {
  //     setCopyFailed(true);
  //   }
  // };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-w-screen-sm rounded-t-[28px] border-border bg-card px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-5"
      >
        <div className="mx-auto mb-5 h-1.5 w-10 rounded-full bg-muted" />
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-400">
            <Send className="h-6 w-6" />
          </span>
          <div>
            <SheetTitle className="text-lg font-black">{community.title}</SheetTitle>
            <SheetDescription className="mt-1 text-sm">{community.description}</SheetDescription>
          </div>
        </div>
        {/* <div className="mt-5 rounded-2xl border border-primary/20 bg-primary/10 p-4 text-sm text-foreground">
          真实加入后可领取 <strong>{community.reward_credits} 星尘</strong>
          。活动上线前已在群的成员不参与本期奖励。
        </div> */}
        {rewarded ? (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-emerald-500/10 p-4 text-sm font-bold text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
            奖励已到账
          </div>
        ) : null}
        {message ? (
          <p role="status" className="mt-4 text-center text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
        {copyFailed ? (
          <p role="alert" className="mt-3 text-center text-sm text-destructive">
            复制失败，请手动搜索 {community.fallback_handle}
          </p>
        ) : null}
        {openFailed ? (
          <div className="mt-4 rounded-2xl border border-border bg-secondary p-4 text-sm text-muted-foreground">
            未能打开社群，请在 Telegram 搜索完整账号{' '}
            <strong className="text-foreground">{community.fallback_handle}</strong>
          </div>
        ) : null}
        <div className="mt-5 grid gap-2.5">
          <Button
            disabled={rewarded || ineligible}
            onClick={() => {
              setOpenFailed(!openTelegramCommunity(community.telegram_url));
            }}
            className="h-12 rounded-2xl"
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            打开官方社群
          </Button>
          {canManuallyVerify && !rewarded && !ineligible ? (
            <Button
              variant="outline"
              disabled={verify.isPending}
              onClick={() => verify.mutate()}
              className="h-12 rounded-2xl"
            >
              {verify.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {verify.isPending ? '正在验证' : '我已加入，立即验证'}
            </Button>
          ) : null}
          {/* {openFailed ? (
            <Button
              variant="ghost"
              onClick={() => void copyHandle()}
              className="h-10 text-muted-foreground"
            >
              <Copy className="mr-2 h-4 w-4" />
              {copied ? '已复制' : `复制 ${community.fallback_handle}`}
            </Button>
          ) : null} */}
        </div>
      </SheetContent>
    </Sheet>
  );
}
