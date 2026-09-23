'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ChevronLeft, Loader2 } from 'lucide-react';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  type CreatePaymentOrderData,
  type PaymentType,
} from '@miniapp/shared';

import { PaymentVpnPromptDialog } from '@/components/payment/payment-vpn-prompt-dialog';
import { VipPlanCard } from '@/components/payment/vip-plan-card';
import { VipBenefitArt } from '@/components/vip/vip-benefit-art';
import { Button } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api/client';
import { useModelCatalogQuery } from '@/lib/api/models';
import { useCreatePaymentOrderMutation, usePaymentPlansQuery } from '@/lib/api/payment';
import { useVipStatusQuery } from '@/lib/api/vip';
import { openCreatedPayment } from '@/lib/payment/open-created-payment';
import {
  capturePaymentMethodSelected,
  capturePaymentOrderCreated,
} from '@/lib/payment/flow-telemetry';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';
import { cn } from '@/lib/utils';
import {
  checkoutButtonLabel,
  formatDiscountLabel,
  publishedDiscountRate,
  resolveCheckoutSelection,
  selectionKey,
  vipMembershipSummary,
} from '@/lib/vip/presentation';

const BENEFITS = [
  '每日签到在基础奖励之外，另行到账 VIP 加成',
  '有效期内可使用标准与旗舰文本模型',
  '有效期内可使用高级图片，仍按价格扣费',
  '三档文本模型按已发布折扣计费；免费轮次优先，不叠加折扣',
];

export default function VipPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.back(), [router]);
  useTelegramBackButton(goBack);
  const { impact, notification, whisper } = useHaptic();
  const plansQuery = usePaymentPlansQuery();
  const vipQuery = useVipStatusQuery();
  const catalogQuery = useModelCatalogQuery();
  const createOrder = useCreatePaymentOrderMutation();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [paymentType] = useState<PaymentType>('wxpay');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [preparedPayment, setPreparedPayment] = useState<CreatePaymentOrderData | null>(null);
  const submitLock = useRef(false);

  const vipPlans = plansQuery.data?.vip_plans ?? [];
  const promptConfig =
    plansQuery.data?.payment_prompt_dialog_config ?? DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
  const selection = useMemo(
    () =>
      resolveCheckoutSelection({
        selectedKey,
        creditPlans: [],
        vipPlans: plansQuery.data?.vip_plans ?? [],
      }),
    [plansQuery.data?.vip_plans, selectedKey]
  );
  const discountLabel = formatDiscountLabel(
    publishedDiscountRate(catalogQuery.data?.catalog.tiers) ?? Number.NaN
  );
  const membership = vipQuery.data ? vipMembershipSummary(vipQuery.data) : null;
  const purchaseClosed = vipPlans.length > 0 && vipPlans.every((plan) => !plan.available);
  const buttonLabel = checkoutButtonLabel({
    pending: createOrder.isPending,
    selection,
    vipActive: vipQuery.data?.active === true,
    creditsButtonText: '立即支付',
    vipVerb: 'immediate',
  });

  const openPrepared = useCallback(
    async (result: CreatePaymentOrderData) => {
      await openCreatedPayment({
        router,
        result,
        returnTo: '/vip',
        paymentType,
      });
    },
    [paymentType, router]
  );

  const handleSelect = (planId: string) => {
    whisper();
    setCheckoutError(null);
    setSelectedKey(selectionKey('vip', planId));
    capturePaymentMethodSelected({ planId, paymentType });
  };

  const handleSubmit = async () => {
    if (!selection || selection.kind !== 'vip' || createOrder.isPending || submitLock.current)
      return;
    if (!selection.available) {
      setCheckoutError('VIP 购买暂未开放，请稍后再试。');
      return;
    }
    submitLock.current = true;
    impact('light');
    setCheckoutError(null);
    try {
      const result = await createOrder.mutateAsync({
        plan_id: selection.id,
        payment_type: paymentType,
      });
      capturePaymentOrderCreated({
        planId: selection.id,
        paymentType,
        orderId: result.order.id,
        amountCents: result.order.amount_cents,
      });
      if (promptConfig.enabled) {
        setPreparedPayment(result);
        setPromptOpen(true);
        return;
      }
      await openPrepared(result);
    } catch (error) {
      notification('error');
      setCheckoutError(
        error instanceof ApiClientError
          ? '暂时无法创建订单，请稍后重试。'
          : '暂时无法创建订单，请稍后重试。'
      );
    } finally {
      submitLock.current = false;
    }
  };

  return (
    <main className="mx-auto flex h-[100dvh] max-w-md flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold">VIP 会员</h1>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <section className="rounded-[24px] border border-primary/25 bg-card px-4 py-4">
          {vipQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">正在确认会员状态</p>
          ) : vipQuery.isError || !membership ? (
            <p className="text-sm text-muted-foreground">会员状态暂时无法确认</p>
          ) : (
            <>
              <p className="text-[11px] font-semibold tracking-[0.16em] text-primary">当前会员</p>
              <h2 className="mt-1 text-lg font-black">{membership.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{membership.detail}</p>
            </>
          )}
          <p className="mt-3 text-[13px] leading-relaxed text-foreground/90">
            {discountLabel
              ? `当前文本折扣 ${discountLabel}。免费轮次优先，不叠加折扣。`
              : '文本折扣以服务端已发布的价格为准。免费轮次优先，不叠加折扣。'}
          </p>
        </section>

        <VipBenefitArt />

        <ul className="space-y-2">
          {BENEFITS.map((benefit) => (
            <li
              key={benefit}
              className="rounded-2xl border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground"
            >
              {benefit}
            </li>
          ))}
        </ul>

        <section role="radiogroup" aria-label="VIP 套餐" className="space-y-3">
          {plansQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              加载套餐
            </div>
          ) : plansQuery.isError ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-6 text-center">
              <p className="text-sm font-semibold">套餐暂时无法加载</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void plansQuery.refetch()}
              >
                重新加载
              </Button>
            </div>
          ) : vipPlans.length === 0 ? (
            <p className="rounded-2xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              VIP 套餐暂时无法购买
            </p>
          ) : (
            vipPlans.map((plan) => (
              <VipPlanCard
                key={plan.id}
                plan={plan}
                selected={selectionKey('vip', plan.id) === selectedKey}
                onSelect={handleSelect}
              />
            ))
          )}
          {purchaseClosed ? (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              VIP 购买暂未开放，当前不会创建订单。
            </p>
          ) : null}
        </section>
      </div>

      <div
        className="shrink-0 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-md"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
      >
        {checkoutError ? (
          <p className="mb-2 flex items-start gap-2 text-[12px] text-destructive" role="alert">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {checkoutError}
          </p>
        ) : null}
        <Button
          disabled={
            !selection || !selection.available || createOrder.isPending || plansQuery.isError
          }
          onClick={() => void handleSubmit()}
          className={cn(
            'h-11 w-full rounded-xl font-bold',
            selection?.available && !createOrder.isPending
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-muted-foreground'
          )}
        >
          {buttonLabel}
        </Button>
      </div>

      <PaymentVpnPromptDialog
        open={promptOpen}
        config={promptConfig}
        canConfirm={Boolean(preparedPayment)}
        onOpenChange={(open) => {
          setPromptOpen(open);
          if (!open) setPreparedPayment(null);
        }}
        onConfirm={() => {
          if (!preparedPayment) return;
          const result = preparedPayment;
          setPromptOpen(false);
          setPreparedPayment(null);
          void openPrepared(result);
        }}
      />
    </main>
  );
}
