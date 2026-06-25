'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, Receipt, ShieldCheck } from 'lucide-react';
import type { PaymentType } from '@miniapp/shared';

import { AlipayIcon, WeChatPayIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { cn } from '@/lib/utils';
import { PlanCard } from '@/components/payment/plan-card';
import { useCreatePaymentOrderMutation, usePaymentPlansQuery } from '@/lib/api/payment';
import { formatYuanShort, paymentTypeLabel } from '@/lib/utils/payment';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';

const PAYMENT_TYPES: PaymentType[] = ['alipay', 'wxpay'];

export default function RechargePage() {
  return (
    <Suspense fallback={<RechargePageSkeleton />}>
      <RechargePageContent />
    </Suspense>
  );
}

function RechargePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { whisper, impact, notification } = useHaptic();

  const goBack = useCallback(() => router.back(), [router]);
  useTelegramBackButton(goBack);

  const { data, isLoading } = usePaymentPlansQuery();
  const createOrder = useCreatePaymentOrderMutation();

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [paymentType, setPaymentType] = useState<PaymentType>('alipay');

  const plans = data?.plans ?? [];
  const reason = searchParams.get('reason');
  const isInsufficientCredits = reason === 'insufficient_credits';
  const selectedPlan = useMemo(
    () => (data?.plans ?? []).find((p) => p.id === selectedPlanId) ?? null,
    [data, selectedPlanId]
  );

  const handleSelect = useCallback(
    (id: string) => {
      whisper();
      setSelectedPlanId(id);
    },
    [whisper]
  );

  const handleSubmit = useCallback(async () => {
    if (!selectedPlan || createOrder.isPending) return;
    impact('light');
    try {
      const result = await createOrder.mutateAsync({
        plan_id: selectedPlan.id,
        payment_type: paymentType,
      });
      const nextPath = `/profile/recharge/${encodeURIComponent(result.order.id)}?pay_url=${encodeURIComponent(result.pay_url)}`;
      router.push(nextPath);
    } catch {
      notification('error');
    }
  }, [selectedPlan, createOrder, paymentType, router, impact, notification]);

  return (
    <main className="mx-auto flex h-[100dvh] max-w-md flex-col bg-[#0A0A0A] text-white">
      <div className="h-1 w-full shrink-0 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />

      <header className="flex shrink-0 items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="-ml-2 rounded-full text-slate-400 hover:text-white"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-lg font-black tracking-wide">星尘商店</h1>
      </header>

      {/* 主区域：story / cards / trust 三段走 justify-between，
          小屏紧凑、大屏自然呼吸 */}
      <div className="flex flex-1 flex-col justify-between px-4 py-4">
        <section className="px-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-slate-200">为每段相遇点一盏星光</p>
            <Link
              href="/profile/orders"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold text-slate-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Receipt className="h-3.5 w-3.5" aria-hidden />
              我的订单
            </Link>
          </div>
          <p className="mt-1 text-[11px] text-pink-300/80">
            {isInsufficientCredits
              ? '余额不足，补充星尘后即可继续对话'
              : '限时福利进行中 · 本轮单价历史最低'}
          </p>
        </section>

        <section className="flex flex-col gap-3 py-4">
          {isLoading && plans.length === 0
            ? Array.from({ length: 4 }).map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-[68px] rounded-xl border border-slate-800 bg-slate-900/40"
                />
              ))
            : plans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  selected={plan.id === selectedPlanId}
                  onSelect={handleSelect}
                />
              ))}
        </section>

        <section className="flex justify-center">
          <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
            <ShieldCheck className="h-3 w-3 text-green-500/80" aria-hidden />
            官方认证 · 安全支付 · 积分即时到账
          </span>
        </section>
      </div>

      {/* 底部固定栏：单行（方法 chips + 立即支付） */}
      <div
        className="shrink-0 border-t border-slate-800 bg-[#0A0A0A]/95 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <div role="radiogroup" aria-label="支付方式" className="flex shrink-0 gap-2">
            {PAYMENT_TYPES.map((t) => {
              const active = paymentType === t;
              const isAlipay = t === 'alipay';
              const Icon = isAlipay ? AlipayIcon : WeChatPayIcon;

              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    whisper();
                    setPaymentType(t);
                  }}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-all',
                    active
                      ? isAlipay
                        ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                        : 'border-[#09B83E] bg-[#09B83E]/15 text-[#09B83E]'
                      : 'border-slate-700 bg-slate-900/50 text-slate-400 hover:bg-slate-800'
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {paymentTypeLabel(t)}
                </button>
              );
            })}
          </div>
          <Button
            disabled={!selectedPlan || createOrder.isPending}
            onClick={handleSubmit}
            className={cn(
              'flex-1 h-10 rounded-xl font-bold transition-all',
              selectedPlan && !createOrder.isPending
                ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white hover:opacity-90 shadow-md shadow-pink-500/30 border-0'
                : 'bg-slate-800 text-slate-500'
            )}
          >
            {createOrder.isPending
              ? '创建中...'
              : selectedPlan
                ? `立即支付 ¥${formatYuanShort(selectedPlan.price_cents)}`
                : '请选择套餐'}
          </Button>
        </div>
      </div>
    </main>
  );
}

function RechargePageSkeleton() {
  return (
    <main className="mx-auto flex h-[100dvh] max-w-md flex-col bg-[#0A0A0A] text-white">
      <div className="h-1 w-full shrink-0 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />
      <header className="flex shrink-0 items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <Skeleton className="h-8 w-8 rounded-full bg-slate-900" />
        <Skeleton className="h-5 w-24 rounded bg-slate-900" />
      </header>
      <div className="flex flex-1 flex-col gap-3 px-4 py-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-[68px] rounded-xl border border-slate-800 bg-slate-900/40"
          />
        ))}
      </div>
    </main>
  );
}
