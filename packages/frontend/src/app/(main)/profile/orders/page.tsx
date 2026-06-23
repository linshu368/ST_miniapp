'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { PaymentOrder, PaymentOrderStatus } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { usePaymentOrdersInfiniteQuery } from '@/lib/api/payment';
import {
  formatNumber,
  formatYuanShort,
  orderStatusLabel,
  paymentTypeLabel,
} from '@/lib/utils/payment';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';

type TabKey = 'all' | 'completed' | 'pending' | 'expired';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'completed', label: '已完成' },
  { key: 'pending', label: '待支付' },
  { key: 'expired', label: '已过期' },
];

function tabToStatus(tab: TabKey): PaymentOrderStatus | 'all' {
  return tab === 'all' ? 'all' : tab;
}

export default function OrdersPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const [tab, setTab] = useState<TabKey>('all');
  const [openOrder, setOpenOrder] = useState<PaymentOrder | null>(null);
  const { whisper } = useHaptic();

  const query = usePaymentOrdersInfiniteQuery(tabToStatus(tab), 20);
  const items = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.items), [query.data]);

  // 无限滚动触发器
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
          void query.fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [query]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-3 backdrop-blur-md">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:text-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-semibold">我的订单</h1>
      </header>

      <div
        role="tablist"
        aria-label="订单筛选"
        className="flex gap-1 border-b border-border/60 px-3 py-2"
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <Button
              key={t.key}
              variant={active ? 'default' : 'ghost'}
              size="sm"
              onClick={() => {
                whisper();
                setTab(t.key);
              }}
              className={cn(
                'rounded-full px-4 h-8 text-xs font-medium transition-colors',
                active ? '' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
            </Button>
          );
        })}
      </div>

      <section className="flex flex-1 flex-col gap-2 px-3 py-3">
        {query.isLoading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> 加载中
          </div>
        ) : items.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          items.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              onOpen={() => {
                whisper();
                setOpenOrder(order);
              }}
            />
          ))
        )}

        <div ref={sentinelRef} aria-hidden className="h-4" />

        {query.isFetchingNextPage ? (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden /> 加载更多
          </div>
        ) : !query.hasNextPage && items.length > 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">到底了</div>
        ) : null}
      </section>

      <Sheet open={openOrder !== null} onOpenChange={(open) => !open && setOpenOrder(null)}>
        <SheetContent side="bottom" className="max-w-md rounded-t-2xl border-t p-0">
          {openOrder ? <OrderDetail order={openOrder} onClose={() => setOpenOrder(null)} /> : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}

function EmptyState({ tab }: { tab: TabKey }) {
  const text =
    tab === 'completed'
      ? '暂无已完成的订单'
      : tab === 'pending'
        ? '暂无待支付的订单'
        : tab === 'expired'
          ? '暂无已过期的订单'
          : '暂无订单';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
      <Clock className="h-10 w-10 opacity-50" aria-hidden />
      <p className="text-sm">{text}</p>
    </div>
  );
}

function OrderRow({ order, onOpen }: { order: PaymentOrder; onOpen: () => void }) {
  const total = order.credits_amount + order.bonus_credits;
  const { Icon, tone } = statusVisual(order.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center justify-between rounded-2xl border border-border/60 bg-card/60 p-4 text-left transition-colors hover:bg-card"
    >
      <div className="flex items-center gap-3">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl', tone)}>
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">¥ {formatYuanShort(order.amount_cents)}</span>
            <span className="text-[10px] text-muted-foreground">
              {orderStatusLabel(order.status)}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {paymentTypeLabel(order.payment_type)} · {formatNumber(total)} 星尘
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground/80">
            {formatDateTime(order.created_at)}
          </div>
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}

function statusVisual(status: PaymentOrderStatus) {
  switch (status) {
    case 'completed':
      return { Icon: CheckCircle2, tone: 'bg-green-500/15 text-green-400' };
    case 'pending':
      return { Icon: Clock, tone: 'bg-amber-500/15 text-amber-400' };
    case 'expired':
      return { Icon: XCircle, tone: 'bg-muted text-muted-foreground' };
    case 'failed':
      return { Icon: XCircle, tone: 'bg-destructive/15 text-destructive' };
  }
}

function OrderDetail({ order, onClose }: { order: PaymentOrder; onClose: () => void }) {
  const total = order.credits_amount + order.bonus_credits;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // 非 https 或不支持时静默
    }
  }, []);

  return (
    <div className="flex flex-col gap-4 p-5 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
      <div aria-hidden className="mx-auto h-1 w-10 rounded-full bg-border" />

      <div className="flex items-center justify-between">
        <SheetTitle className="text-base font-semibold">订单明细</SheetTitle>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
            order.status === 'completed' && 'bg-green-500/15 text-green-400',
            order.status === 'pending' && 'bg-amber-500/15 text-amber-400',
            order.status === 'expired' && 'bg-muted text-muted-foreground',
            order.status === 'failed' && 'bg-destructive/15 text-destructive'
          )}
        >
          {orderStatusLabel(order.status)}
        </span>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-black">¥{formatYuanShort(order.amount_cents)}</span>
        <span className="text-xs text-muted-foreground">
          {paymentTypeLabel(order.payment_type)}
        </span>
      </div>

      <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-card/60">
        <DetailRow label="主积分" value={`${formatNumber(order.credits_amount)} 星尘`} />
        {order.bonus_credits > 0 ? (
          <DetailRow
            label="赠送积分"
            value={`+${formatNumber(order.bonus_credits)} 星尘`}
            valueClass="text-pink-400"
          />
        ) : null}
        <DetailRow label="合计到账" value={`${formatNumber(total)} 星尘`} valueClass="font-bold" />
        <DetailRow label="创建时间" value={formatDateTime(order.created_at)} />
        {order.paid_at ? (
          <DetailRow label="支付时间" value={formatDateTime(order.paid_at)} />
        ) : null}
        <DetailRow
          label="订单号"
          value={
            <CopyableText
              value={order.id}
              copied={copied === 'id'}
              onCopy={() => copy(order.id, 'id')}
            />
          }
        />
        {order.provider_transaction_id ? (
          <DetailRow
            label="渠道流水"
            value={
              <CopyableText
                value={order.provider_transaction_id}
                copied={copied === 'tx'}
                onCopy={() => copy(order.provider_transaction_id ?? '', 'tx')}
              />
            }
          />
        ) : null}
      </div>

      <Button
        variant="secondary"
        onClick={onClose}
        className="mt-4 h-11 w-full rounded-xl text-sm font-medium"
      >
        关闭
      </Button>
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 break-all text-right text-sm', valueClass)}>{value}</span>
    </div>
  );
}

function CopyableText({
  value,
  copied,
  onCopy,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex items-center gap-1 break-all text-right font-mono text-[11px] text-muted-foreground hover:text-foreground"
    >
      <span>{value}</span>
      <Copy className="h-3 w-3 shrink-0" aria-hidden />
      {copied ? <span className="text-[10px] text-green-400">已复制</span> : null}
    </button>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
