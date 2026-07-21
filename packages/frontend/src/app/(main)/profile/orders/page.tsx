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
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-[#080014] text-white">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-white/5 bg-[#080014]/80 px-3 py-3 backdrop-blur-xl pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-white/60 hover:text-white hover:bg-white/10"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">我的订单</h1>
      </header>

      <div
        role="tablist"
        aria-label="订单筛选"
        className="flex gap-2 border-b border-white/5 px-4 py-3 bg-[#080014]/60 backdrop-blur-md"
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <Button
              key={t.key}
              variant="ghost"
              size="sm"
              onClick={() => {
                whisper();
                setTab(t.key);
              }}
              className={cn(
                'rounded-full px-4 h-8 text-xs font-semibold transition-all',
                active
                  ? 'bg-white/10 text-white'
                  : 'bg-transparent text-white/40 hover:text-white hover:bg-white/5'
              )}
            >
              {t.label}
            </Button>
          );
        })}
      </div>

      <section className="flex flex-1 flex-col gap-3 px-4 py-4">
        {query.isLoading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-white/40">
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
          <div className="flex items-center justify-center py-4 text-xs text-white/40">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden /> 加载更多
          </div>
        ) : !query.hasNextPage && items.length > 0 ? (
          <div className="py-4 text-center text-xs text-white/20 font-medium tracking-widest">
            NO MORE
          </div>
        ) : null}
      </section>

      <Sheet open={openOrder !== null} onOpenChange={(open) => !open && setOpenOrder(null)}>
        <SheetContent
          side="bottom"
          className="max-w-md rounded-t-[24px] border-t border-white/10 bg-[#120a1f] p-0 shadow-2xl"
        >
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
          : '这里空空如也';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center text-white/30">
      <div className="rounded-full bg-white/5 p-4 mb-2">
        <Clock className="h-8 w-8 opacity-50" aria-hidden />
      </div>
      <p className="text-[13px] font-medium tracking-wide">{text}</p>
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
      className="group flex items-center justify-between rounded-[20px] border border-white/5 bg-white/[0.03] p-4 text-left transition-all hover:bg-white/[0.06]"
    >
      <div className="flex items-center gap-4">
        <div
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/5',
            tone
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold text-white tracking-tight">
              ¥ {formatYuanShort(order.amount_cents)}
            </span>
            <span
              className={cn(
                'text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-white/5',
                tone.replace('text-', 'bg-').replace('/15', '/10')
              )}
            >
              {orderStatusLabel(order.status)}
            </span>
          </div>
          <div className="mt-1 text-xs text-white/60">
            {paymentTypeLabel(order.payment_type)} · {formatNumber(total)} 星尘
          </div>
          <div className="mt-0.5 text-[10px] text-white/30 font-medium uppercase tracking-wider">
            {formatDateTime(order.created_at)}
          </div>
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-white/20 group-hover:text-white/60 transition-colors" />
    </button>
  );
}

function statusVisual(status: PaymentOrderStatus) {
  switch (status) {
    case 'completed':
      return { Icon: CheckCircle2, tone: 'text-emerald-400' };
    case 'pending':
      return { Icon: Clock, tone: 'text-amber-400' };
    case 'expired':
      return { Icon: XCircle, tone: 'text-white/40' };
    case 'failed':
      return { Icon: XCircle, tone: 'text-rose-400' };
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
    <div className="flex flex-col gap-5 p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] text-white">
      <div aria-hidden className="mx-auto h-1 w-12 rounded-full bg-white/10 mb-2" />

      <div className="flex items-center justify-between">
        <SheetTitle className="text-lg font-bold text-white">订单明细</SheetTitle>
        <span
          className={cn(
            'rounded-full px-3 py-1 text-[11px] font-bold border border-white/5',
            order.status === 'completed' && 'bg-emerald-500/10 text-emerald-400',
            order.status === 'pending' && 'bg-amber-500/10 text-amber-400',
            order.status === 'expired' && 'bg-white/5 text-white/40',
            order.status === 'failed' && 'bg-rose-500/10 text-rose-400'
          )}
        >
          {orderStatusLabel(order.status)}
        </span>
      </div>

      <div className="flex items-baseline gap-1 mt-2 mb-2">
        <span className="text-[40px] font-black tracking-tighter">
          ¥{formatYuanShort(order.amount_cents)}
        </span>
        <span className="text-[13px] font-medium text-white/50 ml-1">
          {paymentTypeLabel(order.payment_type)}
        </span>
      </div>

      <div className="divide-y divide-white/5 rounded-[20px] border border-white/10 bg-white/[0.02]">
        <DetailRow label="主积分" value={`${formatNumber(order.credits_amount)} 星尘`} />
        {order.bonus_credits > 0 ? (
          <DetailRow
            label="赠送积分"
            value={`+${formatNumber(order.bonus_credits)} 星尘`}
            valueClass="text-fuchsia-400"
          />
        ) : null}
        <DetailRow
          label="合计到账"
          value={`${formatNumber(total)} 星尘`}
          valueClass="font-bold text-amber-300"
        />
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
        variant="ghost"
        onClick={onClose}
        className="mt-4 h-12 w-full rounded-2xl bg-white/5 text-[15px] font-bold text-white hover:bg-white/10 border border-white/5"
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
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <span className="shrink-0 text-[13px] text-white/50 font-medium">{label}</span>
      <span className={cn('min-w-0 break-all text-right text-[14px]', valueClass)}>{value}</span>
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
      className="inline-flex items-center gap-1.5 break-all text-right font-mono text-[11px] tracking-wider text-white/50 hover:text-white/80 transition-colors"
    >
      <span>{value}</span>
      <Copy className="h-3 w-3 shrink-0" aria-hidden />
      {copied ? <span className="text-[10px] text-emerald-400 font-bold ml-1">已复制</span> : null}
    </button>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
