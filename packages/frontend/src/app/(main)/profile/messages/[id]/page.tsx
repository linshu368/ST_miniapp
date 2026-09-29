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
import {
  supportsVipRenewal,
  vipExpiryImpactCopy,
  vipExpiryDisplayWindow,
  vipExpiryMembershipDetail,
  vipMembershipSummary,
  vipPlanTitle,
} from '@/lib/vip/presentation';

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
  const impact = vipExpiryImpactCopy(vip.data?.benefits);
  const missing = isMissingNotification(detail.error);
  const expiryWindow = notification ? vipExpiryDisplayWindow(vip.data ?? null, notification) : null;

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
          <article className="flex-1 px-4 py-5 pb-28">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground">
              {notification.scope === 'official' ? 'OFFICIAL NOTICE' : 'MESSAGE'}
            </p>
            <h2 className="mt-2 text-lg font-black tracking-tight">
              {expiryWindow === 'expires_today' ? 'VIP 今日到期' : notification.title}
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              <time dateTime={notification.published_at}>
                {formatMessageTime(notification.published_at)}
              </time>
              {notification.scope === 'official' ? ' · 官方消息' : null}
            </p>

            {showRenew ? (
              <section className="mt-4 rounded-[20px] border border-border/90 bg-card px-4 py-4 shadow-sm ring-1 ring-border/25">
                {vip.isLoading ? (
                  <p className="text-sm text-muted-foreground">正在读取当前会员状态</p>
                ) : vip.isError || !vip.data ? (
                  <p className="text-sm text-muted-foreground">当前会员状态暂时无法确认</p>
                ) : (
                  <MembershipRows
                    title={
                      vip.data.active
                        ? vipPlanTitle(vip.data.last_plan_id)
                        : vipMembershipSummary(vip.data).title
                    }
                    detail={vipExpiryMembershipDetail(vip.data, notification)}
                  />
                )}
              </section>
            ) : null}

            {showRenew ? (
              <VipExpiryBody
                fallbackBody={notification.body}
                checkin={impact.checkin}
                discount={impact.discount}
                window={expiryWindow}
              />
            ) : (
              <p className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">
                {notification.body}
              </p>
            )}
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

function VipExpiryBody({
  fallbackBody,
  checkin,
  discount,
  window,
}: {
  fallbackBody: string;
  checkin: { extra: string; fallback: string } | null;
  discount: string | null;
  window: 'expiring_soon' | 'expires_today' | null;
}) {
  if (window === 'expiring_soon') {
    return (
      <section className="mt-4 space-y-2.5 text-[14px] font-medium leading-relaxed text-foreground/90">
        <p>
          你的 VIP 会员将在 <strong className="font-black text-primary">3 天后到期</strong>
          。到期后以下权益将同时失效：
        </p>
        <ul className="space-y-1.5">
          {checkin ? (
            <li>
              · 每日签到额外 <strong className="font-black text-primary">{checkin.extra}</strong>
              （签到奖励回落为{checkin.fallback}）
            </li>
          ) : null}
          <li>· 标准与旗舰模型使用权限</li>
          {discount ? (
            <li>
              · 全部模型档位 <strong className="font-black text-primary">{discount}</strong>
            </li>
          ) : null}
        </ul>
        <p>续费后有效期将在现有基础上顺延，剩余天数不会作废。</p>
      </section>
    );
  }

  if (window !== 'expires_today') {
    return (
      <p className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">
        {fallbackBody}
      </p>
    );
  }

  return (
    <section className="mt-4 space-y-2.5 text-[14px] font-medium leading-relaxed text-foreground/90">
      <p>
        你的 VIP 会员将于<strong className="font-black text-primary">今日到期</strong>。到期后：
      </p>
      <ul className="space-y-1.5">
        {checkin ? (
          <li>
            · 每日签到额外 <strong className="font-black text-primary">{checkin.extra}</strong>{' '}
            停止发放（签到奖励回落为{checkin.fallback}）
          </li>
        ) : null}
        <li>
          · 标准与旗舰模型将不可用，正在使用的模型
          <strong className="font-black text-primary">自动回落轻量模型</strong>
        </li>
        {discount ? (
          <li>
            · 全部模型档位 <strong className="font-black text-primary">{discount}</strong> 恢复原价
          </li>
        ) : null}
      </ul>
      <p>想继续使用可在今日内续费，续费后有效期顺延。</p>
    </section>
  );
}

function MembershipRows({ title, detail }: { title: string; detail: string }) {
  return (
    <dl className="text-sm">
      <div className="flex min-h-10 items-center justify-between gap-3 pb-3">
        <dt className="text-muted-foreground">当前会员</dt>
        <dd className="font-black text-primary">{title}</dd>
      </div>
      <div className="flex min-h-10 items-center justify-between gap-3 border-t border-border/90 pt-3">
        <dt className="text-muted-foreground">剩余有效期</dt>
        <dd className="text-right font-black text-primary">{detail}</dd>
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
