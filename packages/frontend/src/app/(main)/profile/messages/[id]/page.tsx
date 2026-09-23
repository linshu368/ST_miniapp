'use client';

import { useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api/client';
import { useNotificationDetailQuery } from '@/lib/api/notifications';
import { useVipStatusQuery } from '@/lib/api/vip';
import { useTelegramBackButton } from '@/lib/telegram';
import { formatMessageTime } from '@/lib/utils/notifications';
import { supportsVipRenewal, vipMembershipSummary } from '@/lib/vip/presentation';

export default function NotificationDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile/messages'), [router]);
  useTelegramBackButton(goBack);
  const detail = useNotificationDetailQuery(id);
  const vip = useVipStatusQuery();
  const notification = detail.data?.notification;
  const showRenew = notification ? supportsVipRenewal(notification) : false;
  const missing = isMissingNotification(detail.error);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          aria-label="返回"
          className="rounded-full"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold">
          {notification?.scope === 'personal' ? '消息' : '官方消息'}
        </h1>
      </header>

      {detail.isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
          加载中
        </div>
      ) : missing ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-sm font-semibold">消息不存在</p>
        </div>
      ) : detail.isError || !notification ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-muted-foreground">消息暂时无法加载</p>
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
            重新加载
          </Button>
        </div>
      ) : (
        <>
          <article className="flex-1 space-y-4 px-4 py-5 pb-28">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground">
              {notification.scope === 'official' ? 'OFFICIAL NOTICE' : 'MESSAGE'}
            </p>
            <h2 className="text-2xl font-black tracking-tight">{notification.title}</h2>
            <p className="text-[12px] text-muted-foreground">
              <time dateTime={notification.published_at}>
                {formatMessageTime(notification.published_at)}
              </time>
              {notification.scope === 'official' ? ' · 官方消息' : null}
            </p>

            {showRenew ? (
              <section className="rounded-[22px] border border-border bg-card px-4 py-3">
                {vip.isLoading ? (
                  <p className="text-sm text-muted-foreground">正在读取当前会员状态</p>
                ) : vip.isError || !vip.data ? (
                  <p className="text-sm text-muted-foreground">当前会员状态暂时无法确认</p>
                ) : (
                  <MembershipRows
                    title={vipMembershipSummary(vip.data).title}
                    detail={vipMembershipSummary(vip.data).detail}
                  />
                )}
              </section>
            ) : null}

            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">
              {notification.body}
            </p>
          </article>

          {showRenew ? (
            <div
              className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-md border-t border-border bg-background/95 px-4 py-3 backdrop-blur-md"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
            >
              <Button
                className="h-11 w-full rounded-xl bg-primary font-bold text-primary-foreground"
                onClick={() => router.push('/vip')}
              >
                立即续费
              </Button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}

function MembershipRows({ title, detail }: { title: string; detail: string }) {
  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-muted-foreground">当前会员</dt>
        <dd className="font-semibold text-primary">{title}</dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt className="text-muted-foreground">剩余有效期</dt>
        <dd className="text-right font-semibold">{detail}</dd>
      </div>
    </dl>
  );
}

function isMissingNotification(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.status === 404 ||
    error.code === 'NOTIFICATION_NOT_FOUND' ||
    error.code === 'INVALID_NOTIFICATION_ID'
  );
}
