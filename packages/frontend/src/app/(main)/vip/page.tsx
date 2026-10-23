'use client';

import { usePageReady } from '@/lib/perf/page-ready';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ChevronLeft,
  Crown,
  ChevronRight,
  Gift,
  Loader2,
  Sparkles,
  TicketPercent,
  Zap,
} from 'lucide-react';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  type CreatePaymentOrderData,
  type PaymentType,
} from '@miniapp/shared';

import { PaymentVpnPromptDialog } from '@/components/payment/payment-vpn-prompt-dialog';
import { AlipayPaymentGuidanceDialog } from '@/components/payment/alipay-payment-guidance-dialog';
import { VipBenefitArt } from '@/components/vip/vip-benefit-art';
import { Button } from '@/components/ui/button';
import { AlipayIcon, WeChatPayIcon } from '@/components/icons';
import { formatNumber, formatYuanShort, safePaymentReturnTo } from '@/lib/utils/payment';
import {
  useCheckoutConfirmationMutation,
  useCreatePaymentOrderMutation,
  usePaymentPlansQuery,
} from '@/lib/api/payment';
import { useVipStatusQuery } from '@/lib/api/vip';
import { openCreatedPayment } from '@/lib/payment/open-created-payment';
import { clearCheckoutConfirmation } from '@/lib/payment/open-storage';
import {
  capturePaymentMethodSelected,
  capturePaymentOrderCreated,
} from '@/lib/payment/flow-telemetry';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';
import { cn } from '@/lib/utils';
import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { paymentTypeLabel } from '@/lib/utils/payment';
import {
  formatDiscountLabel,
  resolveCheckoutSelection,
  selectionKey,
  vipMembershipSummary,
} from '@/lib/vip/presentation';

export default function VipPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[100dvh] items-center justify-center text-sm text-muted-foreground">
          正在加载会员权益…
        </div>
      }
    >
      <VipPageContent />
    </Suspense>
  );
}

function VipPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = safePaymentReturnTo(searchParams.get('returnTo')) ?? '/vip';
  const goBack = useCallback(() => router.back(), [router]);
  useTelegramBackButton(goBack);
  const { impact, notification, whisper } = useHaptic();
  const plansQuery = usePaymentPlansQuery();
  const vipQuery = useVipStatusQuery();
  usePageReady('/vip', plansQuery.data !== undefined && vipQuery.data !== undefined);
  const createOrder = useCreatePaymentOrderMutation();
  const { mutate: confirmCheckout } = useCheckoutConfirmationMutation();
  const [paymentType, setPaymentType] = useState<PaymentType>('alipay');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [alipayPromptOpen, setAlipayPromptOpen] = useState(false);
  const [wechatPromptOpen, setWechatPromptOpen] = useState(false);
  const [preparedPayment, setPreparedPayment] = useState<CreatePaymentOrderData | null>(null);
  const submitLock = useRef(false);

  const reportCheckoutConfirmation = useCallback(
    ({ orderId, request }: Parameters<typeof confirmCheckout>[0]) => {
      confirmCheckout(
        { orderId, request },
        { onSuccess: () => clearCheckoutConfirmation(orderId, request.request_id) }
      );
    },
    [confirmCheckout]
  );

  // 商品展示与下单都只接受发布中的月卡，不能在月卡缺失时落回旧周卡。
  const monthlyPlan = plansQuery.data?.vip_plans?.find((plan) => plan.id === 'month');
  const promptConfig =
    plansQuery.data?.payment_prompt_dialog_config ?? DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
  const paymentChannels = plansQuery.data?.payment_channels;
  const paymentTypes = useMemo<PaymentType[]>(() => {
    if (!paymentChannels) return ['alipay'];
    return (['alipay', 'wxpay'] as const).filter((type) =>
      type === 'alipay' ? paymentChannels.alipay_enabled : paymentChannels.wxpay_enabled
    );
  }, [paymentChannels]);
  const defaultPaymentType = paymentChannels?.default_payment_type ?? 'alipay';

  useEffect(() => {
    if (!paymentTypes.includes(paymentType)) setPaymentType(defaultPaymentType);
  }, [defaultPaymentType, paymentType, paymentTypes]);
  const selection = resolveCheckoutSelection({
    selectedKey: monthlyPlan ? selectionKey('vip', monthlyPlan.id) : null,
    creditPlans: [],
    vipPlans: monthlyPlan ? [monthlyPlan] : [],
  });
  const benefits = vipQuery.data?.benefits;
  const discountLabel = formatDiscountLabel(benefits?.text_discount_rate ?? Number.NaN);
  const membership = vipQuery.data ? vipMembershipSummary(vipQuery.data) : null;
  const purchaseClosed = monthlyPlan?.available === false;
  const buttonLabel = createOrder.isPending
    ? '创建订单中…'
    : plansQuery.isLoading
      ? '正在读取月卡…'
      : plansQuery.isError
        ? '月卡暂时无法加载'
        : !monthlyPlan || !monthlyPlan.available
          ? '月卡暂未开放'
          : `${vipQuery.data?.active ? '续费 VIP 月卡' : '开通 VIP 月卡'} ¥${formatYuanShort(monthlyPlan.price_cents)}`;

  const openPrepared = useCallback(
    async (result: CreatePaymentOrderData) => {
      await openCreatedPayment({
        router,
        result,
        returnTo,
        paymentType,
        reportCheckoutConfirmation,
      });
    },
    [paymentType, reportCheckoutConfirmation, returnTo, router]
  );

  const handleSubmit = async () => {
    if (
      !selection ||
      selection.kind !== 'vip' ||
      plansQuery.isError ||
      createOrder.isPending ||
      submitLock.current
    )
      return;
    if (!selection.available) {
      setCheckoutError('VIP 购买暂未开放，请稍后再试。');
      return;
    }
    submitLock.current = true;
    impact('light');
    setCheckoutError(null);
    // 反馈 = 按钮进入「处理中」状态被绘制出来；下单接口耗时由请求指标覆盖。
    const submitAction = startAction('vip_create_order');
    try {
      const creating = createOrder.mutateAsync({
        plan_id: selection.id,
        payment_type: paymentType,
      });
      feedbackAfterPaint(submitAction);
      const result = await creating;
      capturePaymentOrderCreated({
        planId: selection.id,
        paymentType,
        orderId: result.order.id,
        amountCents: result.order.amount_cents,
      });
      if (paymentType === 'alipay') {
        setPreparedPayment(result);
        setAlipayPromptOpen(true);
        return;
      }
      if (promptConfig.enabled) {
        setPreparedPayment(result);
        setWechatPromptOpen(true);
        return;
      }
      await openPrepared(result);
    } catch {
      notification('error');
      setCheckoutError('暂时无法创建订单，请稍后重试。');
    } finally {
      submitLock.current = false;
    }
  };

  return (
    <main className="mx-auto flex h-[100dvh] max-w-md flex-col bg-background text-foreground">
      <header className="relative flex min-h-14 shrink-0 items-center justify-center border-b border-border/60 px-3 pt-[env(safe-area-inset-top)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="absolute left-3 rounded-full text-muted-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold">VIP 会员</h1>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-4 pb-5 pt-4">
        <VipBenefitArt monthlyPlan={monthlyPlan} status={vipQuery.data} />

        <section aria-label="会员专享权益">
          <h2 className="mb-3 px-1 text-sm font-bold">
            {vipQuery.data?.active ? '你的会员权益已生效' : '再享三项会员权益'}
          </h2>
          <div className="grid grid-cols-3 gap-2">
            <div className="min-w-0 rounded-[20px] border border-border bg-card px-2 py-3 text-center">
              <TicketPercent className="mx-auto size-4 text-primary" aria-hidden />
              <p className="mt-2 text-[19px] font-bold tabular-nums text-primary">
                {discountLabel ?? '—'}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">全模型对话</p>
            </div>
            <div className="min-w-0 rounded-[20px] border border-border bg-card px-2 py-3 text-center">
              <Gift className="mx-auto size-4 text-primary" aria-hidden />
              <p className="mt-2 text-[19px] font-bold tabular-nums text-primary">
                {benefits ? `+${formatNumber(benefits.checkin_vip_credits)}` : '—'}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">每日签到多领</p>
            </div>
            <div className="min-w-0 rounded-[20px] border border-border bg-card px-2 py-3 text-center">
              <Zap className="mx-auto size-4 text-primary" aria-hidden />
              <p className="mt-2 text-[17px] font-bold leading-7 text-primary">更多模型</p>
              <p className="mt-1 text-[10px] text-muted-foreground">解锁标准与旗舰</p>
            </div>
          </div>
          <p className="mt-2 px-1 text-[10px] leading-5 text-muted-foreground">
            会员享对话优惠，聊天仍按轮消耗星尘。
          </p>
        </section>

        <section aria-label="VIP 月卡">
          {plansQuery.isLoading ? (
            <div className="flex items-center justify-center rounded-[24px] border border-border bg-card py-10 text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              正在读取月卡
            </div>
          ) : plansQuery.isError ? (
            <div className="rounded-[24px] border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
              <p className="text-sm font-semibold">月卡暂时无法加载</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void plansQuery.refetch()}
              >
                重新加载
              </Button>
            </div>
          ) : !monthlyPlan ? (
            <p className="rounded-[24px] border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              VIP 月卡暂未开放，请稍后再来
            </p>
          ) : (
            <div className="relative overflow-hidden rounded-[24px] border border-primary/40 bg-[linear-gradient(120deg,hsl(var(--primary)/0.14),hsl(var(--card))_75%)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-bold">
                    <Crown className="size-4 text-primary" aria-hidden />
                    {vipQuery.data?.active ? '续费 VIP 月卡' : 'VIP 月卡'}
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {monthlyPlan.duration_days} 天完整会员权益
                  </p>
                </div>
                <p className="text-primary">
                  <span className="text-xs">¥</span>
                  <span className="ml-0.5 text-[30px] font-bold leading-9 tabular-nums">
                    {formatYuanShort(monthlyPlan.price_cents)}
                  </span>
                  <span className="ml-1 text-[10px] text-muted-foreground">/期</span>
                </p>
              </div>
              {monthlyPlan.bonus_credits > 0 ? (
                <div className="mt-4 flex items-start gap-2 rounded-2xl border border-primary/15 bg-primary/[0.06] px-3 py-2.5">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                  <div>
                    <p className="text-xs font-semibold text-primary">
                      {vipQuery.data?.active ? '续费再赠' : '开通赠'}{' '}
                      {formatNumber(monthlyPlan.bonus_credits)} 专项星尘
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      用于轻量模型对话，{vipQuery.data?.active ? '续费' : '开通'}后到账
                    </p>
                  </div>
                </div>
              ) : null}
              {benefits ? (
                <p className="mt-3 text-[10px] leading-5 text-muted-foreground">
                  每日签到共{' '}
                  {formatNumber(benefits.checkin_base_credits + benefits.checkin_vip_credits)}{' '}
                  星尘，记得来领取。
                </p>
              ) : null}
            </div>
          )}
          {purchaseClosed ? (
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              月卡购买暂未开放，请稍后再来。
            </p>
          ) : null}
        </section>

        {vipQuery.isLoading ? (
          <p className="text-center text-[11px] text-muted-foreground">正在确认会员状态</p>
        ) : vipQuery.isError || !membership ? (
          <button
            type="button"
            onClick={() => void vipQuery.refetch()}
            className="min-h-11 w-full text-center text-xs text-primary"
          >
            会员信息暂未加载，点击重试
          </button>
        ) : vipQuery.data?.active || vipQuery.data?.last_plan_id ? (
          <p className="text-center text-[11px] text-primary">
            {membership.title} · {membership.detail}
          </p>
        ) : null}
        <Link
          href={returnTo.startsWith('/profile/recharge') ? returnTo : '/profile/recharge'}
          className="flex min-h-11 items-center justify-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          还想补充星尘？前往星尘充值
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
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
        <div className="space-y-3">
          <div role="radiogroup" aria-label="支付方式" className="flex flex-wrap gap-2">
            {paymentTypes.map((type) => {
              const active = paymentType === type;
              const isAlipay = type === 'alipay';
              const Icon = isAlipay ? AlipayIcon : WeChatPayIcon;

              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    whisper();
                    setPaymentType(type);
                    if (selection) {
                      capturePaymentMethodSelected({ planId: selection.id, paymentType: type });
                    }
                  }}
                  className={cn(
                    'flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                    active
                      ? isAlipay
                        ? 'border-[#1677FF] bg-[#1677FF]/15 text-[#1677FF]'
                        : 'border-[#09B83E] bg-[#09B83E]/15 text-[#09B83E]'
                      : 'border-border bg-card text-muted-foreground hover:bg-secondary'
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {paymentTypeLabel(type)}
                </button>
              );
            })}
          </div>
          <Button
            disabled={
              !selection || !selection.available || createOrder.isPending || plansQuery.isError
            }
            onClick={() => void handleSubmit()}
            className={cn(
              'h-12 w-full rounded-full text-sm font-bold',
              selection?.available && !createOrder.isPending
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground'
            )}
          >
            {buttonLabel}
          </Button>
        </div>
      </div>

      <AlipayPaymentGuidanceDialog
        open={alipayPromptOpen}
        onOpenChange={(open) => {
          setAlipayPromptOpen(open);
          if (!open) setPreparedPayment(null);
        }}
        onConfirm={() => {
          if (!preparedPayment) return;
          const result = preparedPayment;
          setAlipayPromptOpen(false);
          setPreparedPayment(null);
          void openPrepared(result);
        }}
      />
      <PaymentVpnPromptDialog
        open={wechatPromptOpen}
        config={promptConfig}
        canConfirm={Boolean(preparedPayment)}
        onOpenChange={(open) => {
          setWechatPromptOpen(open);
          if (!open) setPreparedPayment(null);
        }}
        onConfirm={() => {
          if (!preparedPayment) return;
          const result = preparedPayment;
          setWechatPromptOpen(false);
          setPreparedPayment(null);
          void openPrepared(result);
        }}
      />
    </main>
  );
}
