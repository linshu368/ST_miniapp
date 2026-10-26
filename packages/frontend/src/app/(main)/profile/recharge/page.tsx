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
  ShieldCheck,
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
import { formatNumber, paymentTypeLabel, safePaymentReturnTo } from '@/lib/utils/payment';
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
  usePageReady('/profile/recharge', data !== undefined);
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
      className="mx-auto flex h-[100dvh] max-w-md flex-col bg-background text-foreground"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/50 px-4 pt-[env(safe-area-inset-top)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="-ml-2 rounded-full text-muted-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold">充值星尘</h1>
        <Link
          href="/profile/orders"
          className="ml-auto inline-flex min-h-11 items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Receipt className="size-3.5" aria-hidden />
          订单
        </Link>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-4 pb-5 pt-4">
        <section aria-label="当前星尘余额" className="px-1">
          <p className="text-[11px] text-muted-foreground">当前星尘余额</p>
          <div className="mt-1 flex items-end justify-between gap-3">
            <p className="min-w-0 truncate text-[30px] font-bold leading-10 tabular-nums tracking-tight">
              {wallet.data ? formatNumber(wallet.data.total_credits ?? wallet.data.credits) : '—'}
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">星尘</span>
            </p>
            <p className="pb-1 text-right text-[10px] leading-4 text-muted-foreground">
              为喜欢的故事
              <br />
              续上星光
            </p>
          </div>
        </section>

        <VipEntryCard
          status={vipStatus.data}
          monthlyPlan={data?.vip_plans?.find((plan) => plan.id === 'month')}
          loading={vipStatus.isLoading || isLoading}
          onOpen={openVip}
        />

        <section aria-label="星尘充值套餐">
          <div className="mb-3 flex items-baseline justify-between gap-2 px-1">
            <h2 className="text-sm font-bold">选择充值金额</h2>
            <span className="text-[10px] text-muted-foreground">星尘即时补充 · 会员独立开通</span>
          </div>
          {isError ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center rounded-[22px] border border-destructive/25 bg-destructive/5 px-6 text-center">
              <AlertCircle className="h-7 w-7 text-destructive" aria-hidden />
              <p className="mt-3 text-sm font-semibold">充值套餐暂时无法加载</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => void refetch()}>
                重新加载
              </Button>
            </div>
          ) : isLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[142px] rounded-[22px]" />
              ))}
            </div>
          ) : plans.length === 0 ? (
            <p className="rounded-[22px] border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              充值套餐暂未开放，请稍后再来
            </p>
          ) : (
            <div role="radiogroup" aria-label="选择星尘充值套餐" className="grid grid-cols-2 gap-3">
              {plans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  selected={selectionKey('credits', plan.id) === selectedKey}
                  selectedColor={pageConfig.selected_plan_color}
                  badgeColor={pageConfig.badge_color}
                  onSelect={handleSelectCredits}
                />
              ))}
            </div>
          )}
        </section>

        {inviteEntryEnabled ? (
          <button
            type="button"
            onClick={goInviteCenter}
            className="flex min-h-14 w-full items-center gap-3 rounded-[20px] border border-border/70 bg-card/60 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Gem className="size-4 shrink-0 text-primary/80" aria-hidden />
            <span className="min-w-0 flex-1 text-xs">邀请好友，也能领取星尘</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        ) : null}
        <p className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground/70">
          <ShieldCheck className="size-3" aria-hidden /> 安全支付 · 到账状态可在订单中查看
        </p>
      </div>

      {/* 底部固定栏：单行（方法 chips + 立即支付） */}
      <div
        className="shrink-0 border-t border-border bg-background/95 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {checkoutError ? (
          <p role="alert" className="px-4 pt-2 text-[12px] text-destructive">
            {checkoutError}
          </p>
        ) : null}
        <div className="space-y-3 px-4 py-3">
          <div role="radiogroup" aria-label="支付方式" className="flex flex-wrap gap-2">
            {paymentTypes.map((t) => {
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
                    if (selection) {
                      capturePaymentMethodSelected({ planId: selection.id, paymentType: t });
                    }
                  }}
                  className={cn(
                    'flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                    // 选中态用支付渠道品牌色，不走主题 token：用户靠颜色识别微信/支付宝。
                    active
                      ? isAlipay
                        ? 'border-[#1677FF] bg-[#1677FF]/15 text-[#1677FF]'
                        : 'border-[#09B83E] bg-[#09B83E]/15 text-[#09B83E]'
                      : 'border-border bg-card text-muted-foreground hover:bg-secondary'
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {paymentTypeLabel(t)}
                </button>
              );
            })}
          </div>
          <Button
            disabled={!selection?.available || isError || createOrder.isPending}
            onClick={() => void handleSubmit()}
            className={cn(
              'h-12 w-full rounded-full text-sm font-bold transition-colors',
              selection?.available && !createOrder.isPending
                ? 'text-primary-foreground hover:opacity-90 border-0'
                : 'bg-secondary text-muted-foreground'
            )}
            style={
              selection?.available && !createOrder.isPending
                ? { backgroundColor: pageConfig.button_color }
                : undefined
            }
          >
            {checkoutButtonLabel({
              pending: createOrder.isPending,
              selection,
              vipActive: false,
              creditsButtonText: pageConfig.button_text,
            })}
          </Button>
        </div>
      </div>
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
                style={{ backgroundColor: pageConfig.button_color }}
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
      <div className="h-1 w-full shrink-0 bg-gradient-to-r from-primary via-rose to-rose-fill" />
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
