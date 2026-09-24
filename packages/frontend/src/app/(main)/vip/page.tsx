'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ChevronLeft,
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
import { VipPlanCard } from '@/components/payment/vip-plan-card';
import { VipBenefitArt } from '@/components/vip/vip-benefit-art';
import { Button } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api/client';
import { WeChatPayIcon } from '@/components/icons';
import { formatNumber, formatYuanShort } from '@/lib/utils/payment';
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
  resolveCheckoutSelection,
  selectionKey,
  vipMembershipSummary,
} from '@/lib/vip/presentation';

export default function VipPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.back(), [router]);
  useTelegramBackButton(goBack);
  const { impact, notification, whisper } = useHaptic();
  const plansQuery = usePaymentPlansQuery();
  const vipQuery = useVipStatusQuery();
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
  // 默认月卡只在用户尚未选择时推导，不覆盖其主动选择。
  const effectiveSelectedKey =
    selectedKey ??
    (vipPlans.find((plan) => plan.id === 'month')
      ? selectionKey('vip', 'month')
      : vipPlans[0]
        ? selectionKey('vip', vipPlans[0].id)
        : null);
  const selection = useMemo(
    () =>
      resolveCheckoutSelection({
        selectedKey: effectiveSelectedKey,
        creditPlans: [],
        vipPlans: plansQuery.data?.vip_plans ?? [],
      }),
    [plansQuery.data?.vip_plans, effectiveSelectedKey]
  );
  const benefits = vipQuery.data?.benefits;
  const discountLabel = formatDiscountLabel(benefits?.text_discount_rate ?? Number.NaN);
  const monthlyPlan = vipPlans.find((plan) => plan.id === 'month');
  const membership = vipQuery.data ? vipMembershipSummary(vipQuery.data) : null;
  const purchaseClosed = vipPlans.length > 0 && vipPlans.every((plan) => !plan.available);
  const defaultButtonLabel = checkoutButtonLabel({
    pending: createOrder.isPending,
    selection,
    vipActive: vipQuery.data?.active === true,
    creditsButtonText: '立即支付',
    vipVerb: 'immediate',
  });

  const buttonLabel =
    selection?.available && !createOrder.isPending
      ? `${vipQuery.data?.active ? '立即续费' : '快捷充值'} ¥${formatYuanShort(selection.priceCents)}`
      : defaultButtonLabel;

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

      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        <VipBenefitArt />

        <section className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2.5 text-[11px]">
          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 font-bold text-emerald-400">
            {discountLabel ? `有效期内 ${discountLabel}` : 'VIP 文本优惠'}
          </span>
          <span className="text-foreground/90">
            {discountLabel
              ? `全部模型档位 ${discountLabel}，随有效期生效、到期即失效`
              : '权益数据暂未加载，请稍后重试'}
          </span>
        </section>

        <ul className="space-y-2">
          <li className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 text-xs">
            <Gift className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-bold">
                {benefits
                  ? `每日签到额外 +${formatNumber(benefits.checkin_vip_credits)} 星尘`
                  : '每日签到额外奖励'}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {benefits
                  ? `基础 ${formatNumber(benefits.checkin_base_credits)} + 额外 ${formatNumber(benefits.checkin_vip_credits)}，每日共 ${formatNumber(benefits.checkin_base_credits + benefits.checkin_vip_credits)}`
                  : '奖励数据暂未加载'}
              </span>
            </div>
          </li>
          <li className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 text-xs">
            <Zap className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div>
              <span className="font-bold">标准与旗舰模型畅用</span>
              <span className="ml-2 text-[10px] text-muted-foreground">切换即时生效</span>
            </div>
          </li>
          <li className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 text-xs">
            <TicketPercent className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div>
              <span className="font-bold">
                {discountLabel ? `全部模型档位 ${discountLabel}` : '全部模型档位享优惠'}
              </span>
              <span className="ml-2 text-[10px] text-muted-foreground">
                轻量 / 标准 / 旗舰，每轮消耗均按折后计
              </span>
            </div>
          </li>
          <li className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 text-xs">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div>
              <span className="font-bold">
                {monthlyPlan
                  ? `月卡赠轻量专属 ${formatNumber(monthlyPlan.bonus_credits)} 星尘`
                  : '月卡赠轻量专属星尘'}
              </span>
              <span className="ml-2 text-[10px] text-muted-foreground">仅轻量模型对话可消耗</span>
            </div>
          </li>
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
                selected={selectionKey('vip', plan.id) === effectiveSelectedKey}
                discountLabel={discountLabel}
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
        <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
          免费轮次优先，不叠加折扣。专项星尘仅可用于轻量文本。
        </p>
        {vipQuery.isLoading ? (
          <p className="text-center text-[11px] text-muted-foreground">正在确认会员状态</p>
        ) : vipQuery.isError || !membership ? (
          <button
            type="button"
            onClick={() => void vipQuery.refetch()}
            className="w-full py-1 text-center text-xs text-primary"
          >
            会员信息暂未加载，点击重试
          </button>
        ) : vipQuery.data?.active || vipQuery.data?.last_plan_id ? (
          <p className="text-center text-[11px] text-primary">
            {membership.title} · {membership.detail}
          </p>
        ) : null}
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
        <div className="flex items-center gap-2.5">
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 text-[11px] font-semibold text-emerald-400">
            <WeChatPayIcon className="h-4 w-4" aria-hidden />
            微信支付
          </span>
          <Button
            disabled={
              !selection || !selection.available || createOrder.isPending || plansQuery.isError
            }
            onClick={() => void handleSubmit()}
            className={cn(
              'h-11 min-w-0 flex-1 rounded-full font-bold',
              selection?.available && !createOrder.isPending
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground'
            )}
          >
            {buttonLabel}
          </Button>
        </div>
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
