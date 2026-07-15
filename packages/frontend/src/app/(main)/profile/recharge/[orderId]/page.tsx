'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, Clock, Loader2, XCircle } from 'lucide-react';
import type { PaymentOrder } from '@miniapp/shared';

import { Button } from '@/components/ui/button';

import { cn } from '@/lib/utils';
import { paymentKeys, usePaymentOrderQuery } from '@/lib/api/payment';
import {
  formatCountdown,
  formatNumber,
  formatYuanShort,
  paymentTypeLabel,
  remainingSeconds,
  safePaymentReturnTo,
} from '@/lib/utils/payment';
import { openExternalUrl, useHaptic, useTelegramBackButton } from '@/lib/telegram';

export default function PaymentPendingPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params?.orderId ? decodeURIComponent(params.orderId) : undefined;
  const search = useSearchParams();
  const payUrl = search?.get('pay_url') ?? null;
  const returnTo = safePaymentReturnTo(search?.get('returnTo') ?? null);

  const router = useRouter();
  const rechargePath = returnTo
    ? `/profile/recharge?returnTo=${encodeURIComponent(returnTo)}`
    : '/profile/recharge';
  const goBack = useCallback(() => router.push(rechargePath), [rechargePath, router]);
  useTelegramBackButton(goBack);

  const queryClient = useQueryClient();
  const { data, isLoading, isError } = usePaymentOrderQuery(orderId);
  const order = data?.order;

  const { notification } = useHaptic();
  const [congratsFired, setCongratsFired] = useState(false);
  const [payUrlOpened, setPayUrlOpened] = useState(false);
  useEffect(() => {
    if (order?.status === 'completed' && !congratsFired) {
      notification('success');
      setCongratsFired(true);
    }
  }, [order?.status, congratsFired, notification]);

  useEffect(() => {
    if (order?.status !== 'completed') return;
    void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
  }, [order?.status, queryClient]);

  useEffect(() => {
    if (!payUrl || payUrlOpened || order?.status !== 'pending') return;
    setPayUrlOpened(true);
    openExternalUrl(payUrl);
  }, [order?.status, payUrl, payUrlOpened]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!order || order.status !== 'pending') return;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [order]);

  const remaining = useMemo(() => {
    if (!order || order.status !== 'pending') return 0;
    return remainingSeconds(order.expires_at, now);
  }, [order, now]);

  if (isLoading || !orderId) {
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  }
  if (isError || !order) {
    return (
      <Screen>
        <ErrorView onBack={goBack} message="订单不存在或加载失败" />
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="flex items-center px-5 pt-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="-ml-2 rounded-full text-slate-400 hover:text-white"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
      </div>

      <div className="flex flex-1 flex-col px-5 pb-10 pt-4">
        {order.status === 'pending' ? (
          <PendingView order={order} remaining={remaining} payUrl={payUrl} onBack={goBack} />
        ) : order.status === 'completed' ? (
          <CompletedView
            order={order}
            onHome={() => router.push(returnTo ?? '/')}
            onOrders={() => router.push('/profile/orders')}
          />
        ) : (
          <TerminalView order={order} onRetry={() => router.push(rechargePath)} onBack={goBack} />
        )}
      </div>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-[#0A0A0A] pt-[env(safe-area-inset-top)] text-white">
      <div className="h-1.5 w-full bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />
      {children}
    </main>
  );
}

function LoadingView() {
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-slate-400">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
      加载中
    </div>
  );
}

function ErrorView({ onBack, message }: { onBack: () => void; message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <XCircle className="h-12 w-12 text-red-400" aria-hidden />
      <div className="text-sm text-slate-300">{message}</div>
      <Button
        variant="outline"
        onClick={onBack}
        className="px-6 border-slate-700 text-slate-300 hover:bg-slate-900"
      >
        返回
      </Button>
    </div>
  );
}

function PendingView({
  order,
  remaining,
  payUrl,
  onBack,
}: {
  order: PaymentOrder;
  remaining: number;
  payUrl: string | null;
  onBack: () => void;
}) {
  const total = order.credits_amount + order.bonus_credits;
  return (
    <div className="flex flex-1 flex-col items-center gap-6 pt-6">
      <div className="relative flex h-24 w-24 items-center justify-center">
        <div className="absolute inset-0 animate-ping rounded-full bg-pink-500/20" aria-hidden />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-purple-600 text-white shadow-lg shadow-pink-500/40">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        </div>
      </div>

      <div className="text-center">
        <h1 className="text-xl font-bold">正在等待支付</h1>
        <p className="mt-1 text-sm text-slate-400">完成付款后积分将自动到账，通常不超过 10 秒</p>
      </div>

      <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <Row label="实付金额" value={`¥ ${formatYuanShort(order.amount_cents)}`} bold />
        <Row label="将到账" value={`${formatNumber(total)} 星尘`} />
        <Row label="支付方式" value={paymentTypeLabel(order.payment_type)} />
        <Row
          label="订单号"
          value={<span className="font-mono text-[11px] text-slate-400">{order.id}</span>}
        />
        <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-3">
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <Clock className="h-3 w-3" aria-hidden /> 订单剩余
          </span>
          <span
            className={cn(
              'font-mono text-sm tabular-nums',
              remaining < 60 ? 'text-red-400' : 'text-slate-200'
            )}
          >
            {formatCountdown(remaining)}
          </span>
        </div>
      </div>

      {payUrl ? (
        <Button
          onClick={() => openExternalUrl(payUrl)}
          className="h-12 w-full rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 font-bold text-white shadow-lg shadow-pink-500/40 hover:opacity-90 border-0"
        >
          重新打开支付页
        </Button>
      ) : null}

      <Button
        variant="outline"
        onClick={onBack}
        className="h-11 w-full rounded-xl border-slate-700 text-slate-300 hover:bg-slate-900"
      >
        暂不支付，返回星尘商店
      </Button>

      <div className="text-center text-[11px] text-slate-500">
        支付完成后会自动跳转；若未自动跳转请稍候
      </div>
    </div>
  );
}

function CompletedView({
  order,
  onHome,
  onOrders,
}: {
  order: PaymentOrder;
  onHome: () => void;
  onOrders: () => void;
}) {
  const total = order.credits_amount + order.bonus_credits;
  return (
    <div className="flex flex-1 flex-col items-center gap-6 pt-8">
      <div className="relative flex h-24 w-24 items-center justify-center">
        <div className="absolute inset-0 rounded-full bg-green-500/15" aria-hidden />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-green-600 text-white shadow-lg shadow-green-500/40">
          <CheckCircle2 className="h-10 w-10" aria-hidden />
        </div>
      </div>

      <div className="text-center">
        <h1 className="text-2xl font-bold">支付成功</h1>
        <p className="mt-2 text-sm text-slate-400">星尘已到账，尽情探索吧</p>
      </div>

      <div className="flex flex-col items-center gap-1">
        <span className="text-xs text-slate-500">本次到账</span>
        <div className="flex items-baseline gap-1">
          <span className="bg-gradient-to-b from-white to-yellow-300 bg-clip-text text-4xl font-black text-transparent">
            +{formatNumber(total)}
          </span>
          <span className="text-xs text-slate-400">星尘</span>
        </div>
        {order.bonus_credits > 0 ? (
          <span className="rounded border border-pink-500/50 bg-pink-500/10 px-2 py-0.5 text-[10px] font-bold text-pink-300">
            含赠送 {formatNumber(order.bonus_credits)}
          </span>
        ) : null}
      </div>

      <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <Row label="实付金额" value={`¥ ${formatYuanShort(order.amount_cents)}`} bold />
        <Row label="支付方式" value={paymentTypeLabel(order.payment_type)} />
        <Row
          label="订单号"
          value={<span className="font-mono text-[11px] text-slate-400">{order.id}</span>}
        />
        {order.provider_transaction_id ? (
          <Row
            label="渠道流水"
            value={
              <span className="font-mono text-[11px] text-slate-400">
                {order.provider_transaction_id}
              </span>
            }
          />
        ) : null}
      </div>

      <div className="mt-auto flex w-full gap-3 pt-6">
        <Button
          variant="outline"
          onClick={onOrders}
          className="flex-1 h-11 rounded-xl border-slate-700 text-slate-300 hover:bg-slate-900"
        >
          查看订单
        </Button>
        <Button
          onClick={onHome}
          className="flex-1 h-11 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 font-bold text-white shadow-lg shadow-pink-500/30 hover:opacity-90 border-0"
        >
          继续探索
        </Button>
      </div>
    </div>
  );
}

function TerminalView({
  order,
  onRetry,
  onBack,
}: {
  order: PaymentOrder;
  onRetry: () => void;
  onBack: () => void;
}) {
  const isExpired = order.status === 'expired';
  return (
    <div className="flex flex-1 flex-col items-center gap-6 pt-8">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-800 text-slate-400">
        <XCircle className="h-10 w-10" aria-hidden />
      </div>
      <div className="text-center">
        <h1 className="text-xl font-bold">{isExpired ? '订单已过期' : '支付失败'}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {isExpired ? '未在 15 分钟内完成支付，可以重新下单' : '请返回重新发起支付'}
        </p>
      </div>
      <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <Row label="订单金额" value={`¥ ${formatYuanShort(order.amount_cents)}`} bold />
        <Row label="支付方式" value={paymentTypeLabel(order.payment_type)} />
        <Row
          label="订单号"
          value={<span className="font-mono text-[11px] text-slate-400">{order.id}</span>}
        />
      </div>
      <Button
        onClick={onRetry}
        className="h-11 w-full rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 font-bold text-white shadow-lg shadow-pink-500/30 hover:opacity-90 border-0"
      >
        重新下单
      </Button>
      <Button
        variant="outline"
        onClick={onBack}
        className="h-11 w-full rounded-xl border-slate-700 text-slate-300 hover:bg-slate-900"
      >
        返回星尘商店
      </Button>
    </div>
  );
}

function Row({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: React.ReactNode;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={cn('text-sm text-slate-200', bold && 'font-bold text-white')}>{value}</span>
    </div>
  );
}
