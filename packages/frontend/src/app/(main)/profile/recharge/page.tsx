'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Gem,
  History,
  Crown,
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
import { PaymentVpnPromptDialog } from '@/components/payment/payment-vpn-prompt-dialog';
import { VipPlanCard } from '@/components/payment/vip-plan-card';
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
import { useCreatePaymentOrderMutation, usePaymentPlansQuery } from '@/lib/api/payment';
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
import { paymentTypeLabel, safePaymentReturnTo } from '@/lib/utils/payment';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';
import {
  checkoutButtonLabel,
  formatDiscountLabel,
  resolveCheckoutSelection,
  selectionKey,
} from '@/lib/vip/presentation';

const PAYMENT_TYPES: PaymentType[] = ['wxpay'];

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
  const vipStatus = useVipStatusQuery();
  const createOrder = useCreatePaymentOrderMutation();
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
  const [paymentType, setPaymentType] = useState<PaymentType>('wxpay');
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const noticeChoiceRef = useRef<'invite' | 'recharge' | null>(null);
  const [paymentPromptOpen, setPaymentPromptOpen] = useState(false);
  const [preparedPayment, setPreparedPayment] = useState<CreatePaymentOrderData | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const submitLock = useRef(false);

  const plans = data?.plans ?? [];
  const vipPlans = data?.vip_plans ?? [];
  const pageConfig = data?.page_config ?? DEFAULT_RECHARGE_PAGE_CONFIG;
  const vipBenefits = vipStatus.data?.benefits;
  const discountLabel = formatDiscountLabel(vipBenefits?.text_discount_rate ?? Number.NaN);
  const paymentPromptConfig =
    data?.payment_prompt_dialog_config ?? DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
  const showInsufficientCreditsNotice =
    searchParams.get('reason') === 'insufficient_credits' && !!data && !noticeDismissed;
  const selection = useMemo(
    () =>
      resolveCheckoutSelection({
        selectedKey,
        creditPlans: data?.plans ?? [],
        vipPlans: data?.vip_plans ?? [],
      }),
    [data?.plans, data?.vip_plans, selectedKey]
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

  const handleSelectVip = useCallback(
    (id: string) => {
      whisper();
      setCheckoutError(null);
      setSelectedKey(selectionKey('vip', id));
      capturePaymentMethodSelected({ planId: id, paymentType });
    },
    [paymentType, whisper]
  );

  const launchPayment = useCallback(
    async (result: CreatePaymentOrderData) => {
      await openCreatedPayment({
        router,
        result,
        returnTo,
        paymentType,
      });
    },
    [paymentType, returnTo, router]
  );

  const handleSubmit = useCallback(async () => {
    if (!selection || createOrder.isPending || submitLock.current) return;
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
      if (paymentPromptConfig.enabled) {
        setPreparedPayment(result);
        setPaymentPromptOpen(true);
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
  ]);

  const handleConfirmPayment = useCallback(() => {
    if (!preparedPayment) return;
    const result = preparedPayment;
    setPaymentPromptOpen(false);
    setPreparedPayment(null);
    void launchPayment(result);
  }, [preparedPayment, launchPayment]);

  const handlePaymentPromptOpenChange = useCallback((open: boolean) => {
    setPaymentPromptOpen(open);
    if (!open) setPreparedPayment(null);
  }, []);

  return (
    <main
      data-app-shell="recharge"
      className="mx-auto flex h-[100dvh] max-w-md flex-col bg-background text-foreground"
    >
      <div className="h-1 w-full shrink-0" style={{ backgroundColor: pageConfig.theme_color }} />

      <header className="flex shrink-0 items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="-ml-2 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-lg font-black tracking-wide">{pageConfig.title}</h1>
      </header>

      {/* 主区域：story / cards / trust 三段走 justify-between，
          小屏紧凑、大屏自然呼吸 */}
      <div className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto px-4 py-4">
        <section className="px-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground/90">{pageConfig.description}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/profile/orders"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-bold text-foreground/90 transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Receipt className="h-3.5 w-3.5" aria-hidden />
                我的订单
              </Link>
              <Link
                href="/profile/spending"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-bold text-foreground/90 transition-colors hover:bg-secondary hover:text-foreground"
              >
                <History className="h-3.5 w-3.5" aria-hidden />
                消耗明细
              </Link>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3 py-4">
          {isError ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-destructive/25 bg-destructive/5 px-6 text-center">
              <AlertCircle className="h-7 w-7 text-destructive" aria-hidden />
              <p className="mt-3 text-sm font-semibold text-foreground">充值套餐暂时无法加载</p>
              <p className="mt-1 text-xs text-muted-foreground">
                请稍后重试，当前不会创建支付订单。
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => void refetch()}>
                重新加载
              </Button>
            </div>
          ) : isLoading && plans.length === 0 ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[68px] rounded-xl border border-border bg-card" />
            ))
          ) : (
            <>
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
              {vipPlans.length > 0 ? (
                <div role="radiogroup" aria-label="VIP 套餐" className="mt-1 space-y-3">
                  <div className="flex items-center gap-2 px-1 text-[12px] font-bold text-primary">
                    <Crown className="h-3.5 w-3.5" aria-hidden />
                    <span>VIP 会员</span>
                    <span className="h-px flex-1 bg-gradient-to-r from-primary/55 to-transparent" />
                  </div>
                  {vipPlans.map((plan) => (
                    <VipPlanCard
                      key={plan.id}
                      plan={plan}
                      selected={selectionKey('vip', plan.id) === selectedKey}
                      discountLabel={discountLabel}
                      checkinBaseCredits={vipBenefits?.checkin_base_credits}
                      checkinVipCredits={vipBenefits?.checkin_vip_credits}
                      variant="recharge"
                      onSelect={handleSelectVip}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}

          {/* 邀请快捷入口：紧挨着套餐列表，保持相同的 gap-3，并对齐高档套餐卡高度 */}
          {inviteEntryEnabled ? (
            <button
              type="button"
              onClick={goInviteCenter}
              className="relative flex h-[86px] w-full items-center gap-3 overflow-hidden rounded-xl border border-[#d946ef] bg-[linear-gradient(135deg,rgba(74,22,87,0.96)_0%,rgba(111,23,84,0.96)_100%)] px-4 text-left shadow-[0_0_22px_rgba(217,70,239,0.28)] transition hover:opacity-80"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-400 text-primary-foreground shadow-md shadow-[0_4px_12px_rgba(217,70,239,0.45)]">
                <Gem className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-black text-foreground">
                  邀请好友得 2200 星尘
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-fuchsia-100/80">
                  分享专属链接，好友首次登录后建立邀请关系
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-primary-foreground" aria-hidden />
            </button>
          ) : null}
        </section>

        <section className="flex justify-center">
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <ShieldCheck className="h-3 w-3 text-success" aria-hidden />
            官方认证 · 安全支付 · 积分即时到账
          </span>
        </section>
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
                    if (selection) {
                      capturePaymentMethodSelected({ planId: selection.id, paymentType: t });
                    }
                  }}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-all',
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
            disabled={!selection?.available || createOrder.isPending}
            onClick={() => void handleSubmit()}
            className={cn(
              'flex-1 h-10 rounded-xl font-bold transition-all',
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
              vipActive: vipStatus.data?.active === true,
              creditsButtonText: pageConfig.button_text,
            })}
          </Button>
        </div>
      </div>
      <PaymentVpnPromptDialog
        open={paymentPromptOpen}
        config={paymentPromptConfig}
        canConfirm={Boolean(preparedPayment)}
        onOpenChange={handlePaymentPromptOpenChange}
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
