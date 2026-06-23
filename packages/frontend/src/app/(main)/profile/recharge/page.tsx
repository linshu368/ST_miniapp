'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ShieldCheck } from 'lucide-react';
import type { PaymentType } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { PlanCard } from '@/components/payment/plan-card';
import { useCreatePaymentOrderMutation, usePaymentPlansQuery } from '@/lib/api/payment';
import { formatYuanShort, paymentTypeLabel } from '@/lib/utils/payment';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';

const PAYMENT_TYPES: PaymentType[] = ['alipay', 'wxpay'];

export default function RechargePage() {
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
        <button
          type="button"
          aria-label="返回"
          onClick={goBack}
          className="-ml-2 flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:text-white"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="text-lg font-black tracking-wide">星尘商店</h1>
      </header>

      {/* 主区域：story / cards / trust 三段走 justify-between，
          小屏紧凑、大屏自然呼吸 */}
      <div className="flex flex-1 flex-col justify-between px-4 py-4">
        <section className="px-1">
          <p className="text-sm font-medium text-slate-200">为每段相遇点一盏星光</p>
          <p className="mt-1 text-[11px] text-pink-300/80">
            {isInsufficientCredits
              ? '余额不足，补充星尘后即可继续对话'
              : '限时福利进行中 · 本轮单价历史最低'}
          </p>
        </section>

        <section className="flex flex-col gap-3 py-4">
          {isLoading && plans.length === 0
            ? Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[68px] animate-pulse rounded-xl border border-slate-800 bg-slate-900/40"
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
        <div className="flex items-center gap-2 px-4 py-3">
          <div role="radiogroup" aria-label="支付方式" className="flex shrink-0 gap-1.5">
            {PAYMENT_TYPES.map((t) => {
              const active = paymentType === t;
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
                    'rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    active
                      ? t === 'alipay'
                        ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                        : 'border-green-500 bg-green-500/15 text-green-300'
                      : 'border-slate-700 bg-slate-900/50 text-slate-400'
                  )}
                >
                  {paymentTypeLabel(t)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={!selectedPlan || createOrder.isPending}
            onClick={handleSubmit}
            className={cn(
              'flex h-10 flex-1 items-center justify-center gap-1 rounded-xl text-sm font-bold transition-all',
              selectedPlan && !createOrder.isPending
                ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-md shadow-pink-500/30'
                : 'bg-slate-800 text-slate-500'
            )}
          >
            {createOrder.isPending
              ? '创建中...'
              : selectedPlan
                ? `立即支付 ¥${formatYuanShort(selectedPlan.price_cents)}`
                : '请选择套餐'}
          </button>
        </div>
      </div>
    </main>
  );
}
