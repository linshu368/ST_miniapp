'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Gem,
  Receipt,
  Check,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  type CreatePaymentOrderData,
  type PaymentType,
} from '@miniapp/shared';

import { AlipayIcon, WeChatPayIcon } from '@/components/icons';
import { AlipayPaymentGuidanceDialog } from '@/components/payment/alipay-payment-guidance-dialog';
import { PaymentVpnPromptDialog } from '@/components/payment/payment-vpn-prompt-dialog';
import { VipEntryCard } from '@/components/vip/vip-entry-card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

import { cn } from '@/lib/utils';
import { PlanCard } from '@/components/payment/plan-card';
import { useInviteEntryStatusQuery } from '@/lib/api/invite';
import {
  useCheckoutConfirmationMutation,
  useCreatePaymentOrderMutation,
  usePaymentPlansQuery,
  useWalletBalanceQuery,
} from '@/lib/api/payment';
import { useVipStatusQuery } from '@/lib/api/vip';
import {
  capturePaymentMethodSelected,
  capturePaymentOrderCreated,
  capturePaywallDismissed,
  capturePaywallInviteSelected,
  capturePaywallRechargeSelected,
  captureRechargeViewed,
  resumePaymentReplayFromPending,
  retainPaywallFollowupIfActive,
} from '@/lib/payment/flow-telemetry';
import { openCreatedPayment } from '@/lib/payment/open-created-payment';
import { clearCheckoutConfirmation } from '@/lib/payment/open-storage';
import {
  formatNumber,
  paymentTypeLabel,
  safePaymentReturnTo,
  totalCredits,
} from '@/lib/utils/payment';
import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { usePageReady } from '@/lib/perf/page-ready';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';
import {
  checkoutButtonLabel,
  resolveCheckoutSelection,
  selectionKey,
} from '@/lib/vip/presentation';

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
  const returnTo = safePaymentReturnTo(searchParams.get('returnTo'));

  const goBack = useCallback(() => router.back(), [router]);
  useTelegramBackButton(goBack);

  const { data, isLoading, isError, refetch } = usePaymentPlansQuery();
  usePageReady('/profile/recharge', data !== undefined && !isError, false, isError);
  const vipStatus = useVipStatusQuery();
  const wallet = useWalletBalanceQuery();
  const createOrder = useCreatePaymentOrderMutation();
  const { mutate: confirmCheckout } = useCheckoutConfirmationMutation();
  const inviteEntry = useInviteEntryStatusQuery();
  const inviteEntryEnabled = inviteEntry.data?.entry_enabled === true;

  const goInviteCenter = useCallback(() => {
    capturePaywallInviteSelected();
    router.push('/profile/invite');
  }, [router]);

  useEffect(() => {
    retainPaywallFollowupIfActive();
    resumePaymentReplayFromPending();
    captureRechargeViewed();
  }, []);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [paymentType, setPaymentType] = useState<PaymentType>('alipay');
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const noticeChoiceRef = useRef<'invite' | 'recharge' | null>(null);
  const [alipayPromptOpen, setAlipayPromptOpen] = useState(false);
  const [wechatPromptOpen, setWechatPromptOpen] = useState(false);
  const [preparedPayment, setPreparedPayment] = useState<CreatePaymentOrderData | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
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

  const plans = data?.plans ?? [];
  const pageConfig = data?.page_config ?? DEFAULT_RECHARGE_PAGE_CONFIG;
  const paymentPromptConfig =
    data?.payment_prompt_dialog_config ?? DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
  // 旧的默认荧光配色使用新皮肤；运营明确配置过的颜色仍生效。
  const selectedPlanColor =
    pageConfig.selected_plan_color === DEFAULT_RECHARGE_PAGE_CONFIG.selected_plan_color
      ? '#d0b99a'
      : pageConfig.selected_plan_color;
  const badgeColor =
    pageConfig.badge_color === DEFAULT_RECHARGE_PAGE_CONFIG.badge_color
      ? '#d0b99a'
      : pageConfig.badge_color;
  const buttonColor =
    pageConfig.button_color === DEFAULT_RECHARGE_PAGE_CONFIG.button_color
      ? '#ead7bc'
      : pageConfig.button_color;
  const paymentChannels = data?.payment_channels;
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
  const showInsufficientCreditsNotice =
    searchParams.get('reason') === 'insufficient_credits' && !!data && !noticeDismissed;
  const selection = useMemo(
    () =>
      resolveCheckoutSelection({
        selectedKey,
        creditPlans: data?.plans ?? [],
        vipPlans: [],
      }),
    [data?.plans, selectedKey]
  );

  const selectedPlan = plans.find((plan) => plan.id === selection?.id);
  const paymentAvailable = paymentTypes.includes(paymentType);

  const handleSelectCredits = useCallback(
    (id: string) => {
      whisper();
      setCheckoutError(null);
      setSelectedKey(selectionKey('credits', id));
      capturePaymentMethodSelected({ planId: id, paymentType });
    },
    [paymentType, whisper]
  );

  const openVip = () => {
    // 开通会员后仍回到充值流程，并保留原聊天回流地址；不重复弹余额不足提示。
    const rechargeReturn = returnTo
      ? `/profile/recharge?${new URLSearchParams({ returnTo })}`
      : '/profile/recharge';
    router.push(`/vip?${new URLSearchParams({ returnTo: rechargeReturn })}`);
  };

  const launchPayment = useCallback(
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

  const handleSubmit = useCallback(async () => {
    if (
      !selection ||
      selection.kind !== 'credits' ||
      !paymentAvailable ||
      isError ||
      createOrder.isPending ||
      submitLock.current
    )
      return;
    submitLock.current = true;
    impact('light');
    setCheckoutError(null);
    // 反馈 = 按钮进入「处理中」状态被绘制出来；下单接口本身的耗时由请求指标覆盖。
    const submitAction = startAction('recharge_create_order');
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
      if (paymentPromptConfig.enabled) {
        setPreparedPayment(result);
        setWechatPromptOpen(true);
        return;
      }
      await launchPayment(result);
    } catch {
      notification('error');
      setCheckoutError('暂时无法创建订单，请稍后重试。');
    } finally {
      submitLock.current = false;
    }
  }, [
    selection,
    paymentAvailable,
    createOrder,
    impact,
    paymentPromptConfig.enabled,
    paymentType,
    launchPayment,
    notification,
    isError,
  ]);

  const handleConfirmPayment = useCallback(() => {
    if (!preparedPayment) return;
    const result = preparedPayment;
    setAlipayPromptOpen(false);
    setWechatPromptOpen(false);
    setPreparedPayment(null);
    void launchPayment(result);
  }, [preparedPayment, launchPayment]);

  const handleAlipayPromptOpenChange = useCallback((open: boolean) => {
    setAlipayPromptOpen(open);
    if (!open) setPreparedPayment(null);
  }, []);

  const handleWechatPromptOpenChange = useCallback((open: boolean) => {
    setWechatPromptOpen(open);
    if (!open) setPreparedPayment(null);
  }, []);

  return (
    <main
      data-app-shell="recharge"
      className="mx-auto flex h-[100dvh] max-w-md flex-col bg-[#191619] text-[#f2ece5]"
    >
      <header className="grid shrink-0 grid-cols-[44px_1fr_44px] items-center px-4 pb-1 pt-[calc(env(safe-area-inset-top)+0.375rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="-ml-2 size-11 rounded-full text-[#c5bdb9] hover:bg-white/5"
          aria-label="返回"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </Button>
        <h1 className="text-center text-[15px] font-medium tracking-wide">充值星尘</h1>
        <Link
          href="/profile/orders"
          className="inline-flex min-h-11 items-center justify-end gap-1 text-[11px] text-[#aba09f] hover:text-[#f2ece5]"
        >
          <Receipt className="size-3.5" aria-hidden />
          订单
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <section
          aria-label="当前星尘余额"
          className="relative flex min-h-[132px] items-center justify-between gap-4 border-b border-white/[0.07] py-5"
        >
          <div className="relative z-10 min-w-0">
            <p className="text-[11px] tracking-[0.08em] text-[#b0a4a2]">我的星尘</p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="text-[38px] font-medium leading-[46px] tabular-nums tracking-[-0.045em]">
                {wallet.data ? formatNumber(wallet.data.total_credits ?? wallet.data.credits) : '—'}
              </span>
              <span className="text-[11px] text-[#b0a4a2]">可用余额</span>
            </p>
            <p className="mt-1 text-[11px] leading-5 text-[#a99b9b]">
              {wallet.isError
                ? '余额暂未获取，可稍后在订单中查看到账'
                : '为心动的故事，留一点星光。'}
            </p>
          </div>
          <div
            aria-hidden
            className="pointer-events-none relative grid size-[76px] shrink-0 place-items-center rounded-full border border-[#d7bd96]/[0.12] bg-[radial-gradient(ellipse_at_center,#baa58418,transparent_70%)]"
          >
            <div className="absolute inset-2 rounded-full border border-[#d7bd96]/[0.07]" />
            <Gem className="size-9 -rotate-12 text-[#d7bd96]/70" strokeWidth={0.8} />
            <span className="absolute right-2 top-2 size-1 rounded-full bg-[#e6d3b8]/60" />
          </div>
        </section>

        <section aria-label="星尘充值套餐" className="pt-5">
          <div className="mb-5 flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-medium">选择星尘套餐</h2>
            <span className="text-[11px] text-[#c9b59a]">到账含赠送星尘</span>
          </div>
          {isError ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center rounded-[20px] border border-white/10 bg-white/[0.025] px-6 text-center">
              <AlertCircle className="size-6 text-[#c4aaa1]" aria-hidden />
              <p className="mt-3 text-sm font-medium">充值套餐暂时无法加载</p>
              <p className="mt-1 text-xs text-[#a99b9b]">稍后重试，已付款的订单仍可查看</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 min-h-11 rounded-full"
                onClick={() => void refetch()}
              >
                重新加载
              </Button>
            </div>
          ) : isLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[158px] rounded-[18px] bg-white/5" />
              ))}
            </div>
          ) : plans.length === 0 ? (
            <p className="rounded-[20px] border border-white/10 bg-white/[0.025] px-4 py-8 text-center text-sm text-[#b0a4a2]">
              充值套餐暂未开放，请稍后再来
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label="选择星尘充值套餐"
              className={cn(
                'grid gap-x-3 gap-y-4',
                plans.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
              )}
            >
              {plans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  selected={selectionKey('credits', plan.id) === selectedKey}
                  selectedColor={selectedPlanColor}
                  badgeColor={badgeColor}
                  disabled={createOrder.isPending}
                  onSelect={handleSelectCredits}
                />
              ))}
            </div>
          )}
          {!isLoading && !isError && plans.some((plan) => plan.bonus_credits > 0) ? (
            <p className="mt-3 text-[10px] leading-5 text-[#a99b9b]">
              赠送已含在到账数内，可用于轻量模型对话。
            </p>
          ) : null}
        </section>

        <div className="mt-6">
          <VipEntryCard
            status={vipStatus.data}
            monthlyPlan={data?.vip_plans?.find((plan) => plan.id === 'month')}
            loading={vipStatus.isLoading || isLoading}
            onOpen={openVip}
            variant="recharge"
          />
        </div>

        <section
          aria-label="充值说明"
          className="mt-5 divide-y divide-white/[0.06] text-[11px] text-[#ad9fa0]"
        >
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7bfa1] [&::-webkit-details-marker]:hidden">
              星尘和 VIP 有什么区别？
              <ChevronRight
                className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                aria-hidden
              />
            </summary>
            <p className="pb-4 leading-6">
              星尘用于对话与生成等功能；VIP
              提供会员专属权益。充值和开通会员可以搭配使用，本次只购买你选择的星尘套餐。
            </p>
          </details>
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7bfa1] [&::-webkit-details-marker]:hidden">
              付款后，星尘什么时候到账？
              <ChevronRight
                className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                aria-hidden
              />
            </summary>
            <p className="pb-4 leading-6">
              {pageConfig.pending_arrival_hint}
              。可在右上角「订单」查看进度；如遇到问题，可以联系在线客服。
            </p>
          </details>
        </section>
        <div className="mt-2 flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-[#ad9fa0]">
          <Link
            href="/profile/support"
            className="inline-flex min-h-11 items-center gap-1.5 hover:text-[#e6d3b8]"
          >
            <MessageCircle className="size-3.5" aria-hidden />
            充值遇到问题？联系客服
          </Link>
          {inviteEntryEnabled ? (
            <button
              type="button"
              onClick={goInviteCenter}
              className="inline-flex min-h-11 items-center gap-1 hover:text-[#e6d3b8]"
            >
              邀请得星尘
              <ChevronRight className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      <footer
        aria-label="充值确认"
        className="z-10 shrink-0 border-t border-white/[0.08] bg-[#211d21] px-5 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2.5 shadow-[0_-8px_24px_#00000012]"
      >
        {checkoutError ? (
          <p role="alert" className="pb-2 text-[12px] leading-5 text-[#e9a9a3]">
            {checkoutError}
          </p>
        ) : null}
        <div className="mb-2.5 flex min-h-11 items-center justify-between gap-2">
          <span className="shrink-0 text-[11px] text-[#b2a5a4]">支付方式</span>
          <div role="radiogroup" aria-label="支付方式" className="flex flex-wrap justify-end gap-2">
            {paymentTypes.map((t) => {
              const active = paymentType === t;
              const Icon = t === 'alipay' ? AlipayIcon : WeChatPayIcon;
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={createOrder.isPending}
                  onClick={() => {
                    whisper();
                    setPaymentType(t);
                    if (selection)
                      capturePaymentMethodSelected({ planId: selection.id, paymentType: t });
                  }}
                  className={cn(
                    'flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs transition-colors disabled:opacity-60',
                    active
                      ? 'border-white/15 bg-white/[0.04] text-[#f2ece5]'
                      : 'border-transparent text-[#a99b9b] hover:bg-white/5'
                  )}
                >
                  <Icon
                    className={cn('size-4', t === 'alipay' ? 'text-[#409cff]' : 'text-[#51bb7b]')}
                    aria-hidden
                  />
                  {paymentTypeLabel(t)}
                  {active ? <Check className="ml-0.5 size-3 text-[#d8c1a2]" aria-hidden /> : null}
                </button>
              );
            })}
            {paymentTypes.length === 0 ? (
              <span className="text-xs text-[#b2a5a4]">暂不可用，请稍后再试</span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1">
            {selectedPlan && !isError ? (
              <>
                <p className="flex flex-wrap items-baseline gap-x-1 text-[#f0e5d8]">
                  <span className="text-[10px] text-[#b2a5a4]">到账</span>
                  <strong className="text-[21px] font-medium tabular-nums tracking-tight">
                    {formatNumber(totalCredits(selectedPlan))}
                  </strong>
                  <span className="text-[10px] text-[#b2a5a4]">星尘</span>
                </p>
                <p className="mt-0.5 text-[10px] leading-4 text-[#baa48c]">
                  {selectedPlan.bonus_credits > 0
                    ? `含赠送 ${formatNumber(selectedPlan.bonus_credits)} 星尘`
                    : '已选星尘充值套餐'}
                </p>
              </>
            ) : (
              <>
                <p className="text-[13px] text-[#e1d6cd]">
                  {isError ? '等待套餐恢复' : '选一份星尘'}
                </p>
                <p className="mt-1 text-[10px] text-[#a99b9b]">确认金额后再付款</p>
              </>
            )}
          </div>
          <Button
            disabled={
              !selection?.available || !paymentAvailable || isError || createOrder.isPending
            }
            onClick={() => void handleSubmit()}
            className="min-h-[52px] w-auto min-w-[145px] max-w-[62%] shrink-0 whitespace-normal rounded-2xl px-5 text-[13px] font-semibold leading-5 text-[#292119] shadow-none transition-colors hover:brightness-105 disabled:bg-[#393237] disabled:text-[#968a8f] disabled:opacity-100 motion-reduce:transition-none"
            style={{
              backgroundColor:
                selection?.available && paymentAvailable && !isError && !createOrder.isPending
                  ? buttonColor
                  : undefined,
            }}
          >
            {checkoutButtonLabel({
              pending: createOrder.isPending,
              selection,
              vipActive: false,
              creditsButtonText: pageConfig.button_text,
            })}
          </Button>
        </div>
      </footer>
      <AlipayPaymentGuidanceDialog
        open={alipayPromptOpen}
        onOpenChange={handleAlipayPromptOpenChange}
        onConfirm={handleConfirmPayment}
      />
      <PaymentVpnPromptDialog
        open={wechatPromptOpen}
        config={paymentPromptConfig}
        canConfirm={Boolean(preparedPayment)}
        onOpenChange={handleWechatPromptOpenChange}
        onConfirm={handleConfirmPayment}
      />
      <Dialog
        open={showInsufficientCreditsNotice}
        onOpenChange={(open) => {
          if (open) return;
          setNoticeDismissed(true);
          if (noticeChoiceRef.current === 'invite' || noticeChoiceRef.current === 'recharge') {
            return;
          }
          capturePaywallDismissed();
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-2xl border-border bg-popover text-popover-foreground">
          <DialogHeader className="items-center text-center">
            <div
              className="mb-2 flex h-12 w-12 items-center justify-center rounded-full"
              style={{
                color: pageConfig.balance_color,
                backgroundColor: `${pageConfig.balance_color}26`,
              }}
            >
              <Sparkles className="h-6 w-6" aria-hidden />
            </div>
            <DialogTitle>星尘不足</DialogTitle>
            <DialogDescription className="pt-1 leading-6 text-muted-foreground">
              {data?.insufficient_credits_notice}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            <DialogClose asChild>
              <Button
                className="w-full rounded-xl font-bold text-primary-foreground"
                style={{ backgroundColor: buttonColor }}
                onClick={() => {
                  noticeChoiceRef.current = 'recharge';
                  capturePaywallRechargeSelected();
                }}
              >
                选择套餐
              </Button>
            </DialogClose>
            {inviteEntryEnabled ? (
              <Button
                variant="outline"
                className="w-full rounded-xl border-rose/40 bg-transparent font-bold text-rose hover:bg-rose/10 hover:text-rose"
                onClick={() => {
                  // PRD：关闭当前提示并直接进入邀请中心
                  noticeChoiceRef.current = 'invite';
                  setNoticeDismissed(true);
                  goInviteCenter();
                }}
              >
                邀请好友得星尘
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function RechargePageSkeleton() {
  return (
    <main className="mx-auto flex h-[100dvh] max-w-md flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <Skeleton className="h-8 w-8 rounded-full bg-card" />
        <Skeleton className="h-5 w-24 rounded bg-card" />
      </header>
      <div className="flex flex-1 flex-col gap-3 px-4 py-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-xl border border-border bg-card" />
        ))}
      </div>
    </main>
  );
}
