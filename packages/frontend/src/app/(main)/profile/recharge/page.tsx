'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ChevronLeft, History, Receipt, ShieldCheck, Sparkles } from 'lucide-react';
import {
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  type PaymentType,
} from '@miniapp/shared';

import { AlipayIcon, WeChatPayIcon } from '@/components/icons';
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
import { useCreatePaymentOrderMutation, usePaymentPlansQuery } from '@/lib/api/payment';
import { formatYuanShort, paymentTypeLabel, safePaymentReturnTo } from '@/lib/utils/payment';
import { openPaymentUrl, useHaptic, useTelegramBackButton } from '@/lib/telegram';

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
  const createOrder = useCreatePaymentOrderMutation();

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [paymentType, setPaymentType] = useState<PaymentType>('wxpay');
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [paymentPromptOpen, setPaymentPromptOpen] = useState(false);

  const plans = data?.plans ?? [];
  const pageConfig = data?.page_config ?? DEFAULT_RECHARGE_PAGE_CONFIG;
  const paymentPromptConfig =
    data?.payment_prompt_dialog_config ?? DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG;
  const showInsufficientCreditsNotice =
    searchParams.get('reason') === 'insufficient_credits' && !!data && !noticeDismissed;
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

  const executePayment = useCallback(async () => {
    if (!selectedPlan || createOrder.isPending) return;
    try {
      const result = await createOrder.mutateAsync({
        plan_id: selectedPlan.id,
        payment_type: paymentType,
      });
      const nextSearch = new URLSearchParams({
        pay_url: result.pay_url,
        payment_started: '1',
      });
      if (returnTo) nextSearch.set('returnTo', returnTo);
      // 必须在 router.push 之前：拉起若退化成本页导航，会被随后的客户端路由抢跑丢弃，
      // 而等待页的自动拉起又被 payment_started=1 短路，结果是一次都没拉起。
      openPaymentUrl(result.pay_url);
      router.push(
        `/profile/recharge/${encodeURIComponent(result.order.id)}?${nextSearch.toString()}`
      );
    } catch {
      notification('error');
    }
  }, [selectedPlan, createOrder, paymentType, router, returnTo, notification]);

  const handleSubmit = useCallback(() => {
    if (!selectedPlan || createOrder.isPending) return;
    impact('light');
    if (paymentPromptConfig.enabled) {
      setPaymentPromptOpen(true);
      return;
    }
    void executePayment();
  }, [selectedPlan, createOrder.isPending, impact, paymentPromptConfig.enabled, executePayment]);

  const handleConfirmPayment = useCallback(() => {
    setPaymentPromptOpen(false);
    void executePayment();
  }, [executePayment]);

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
      <div className="flex flex-1 flex-col justify-between px-4 py-4">
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
            plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                selected={plan.id === selectedPlanId}
                selectedColor={pageConfig.selected_plan_color}
                badgeColor={pageConfig.badge_color}
                onSelect={handleSelect}
              />
            ))
          )}
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
            disabled={!selectedPlan || createOrder.isPending}
            onClick={handleSubmit}
            className={cn(
              'flex-1 h-10 rounded-xl font-bold transition-all',
              selectedPlan && !createOrder.isPending
                ? 'text-primary-foreground hover:opacity-90 border-0'
                : 'bg-secondary text-muted-foreground'
            )}
            style={
              selectedPlan && !createOrder.isPending
                ? { backgroundColor: pageConfig.button_color }
                : undefined
            }
          >
            {createOrder.isPending
              ? '创建中...'
              : selectedPlan
                ? `${pageConfig.button_text} ¥${formatYuanShort(selectedPlan.price_cents)}`
                : '请选择套餐'}
          </Button>
        </div>
      </div>
      <Dialog open={paymentPromptOpen} onOpenChange={setPaymentPromptOpen}>
        <DialogContent
          className="w-[calc(100%-2rem)] max-w-sm overflow-hidden rounded-3xl border-2 bg-popover p-0 text-popover-foreground"
          style={{ borderColor: paymentPromptConfig.accent_color }}
        >
          <div
            className="h-1.5 w-full"
            style={{ backgroundColor: paymentPromptConfig.accent_color }}
          />
          <div className="px-6 pb-6 pt-5">
            <DialogHeader className="items-center text-center">
              <div
                className="mb-2 flex h-14 w-14 items-center justify-center rounded-full border-2"
                style={{
                  color: paymentPromptConfig.accent_color,
                  borderColor: paymentPromptConfig.accent_color,
                  backgroundColor: `${paymentPromptConfig.accent_color}1f`,
                }}
              >
                <AlertCircle className="h-8 w-8" aria-hidden />
              </div>
              <DialogTitle className="text-xl font-black">{paymentPromptConfig.title}</DialogTitle>
              <DialogDescription className="whitespace-pre-line pt-1 text-center leading-6 text-muted-foreground">
                {paymentPromptConfig.description}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-5">
              <Button
                className="w-full rounded-xl border-0 font-black text-[#171717] hover:opacity-90"
                style={{ backgroundColor: paymentPromptConfig.accent_color }}
                disabled={createOrder.isPending}
                onClick={handleConfirmPayment}
              >
                {createOrder.isPending ? '创建中...' : paymentPromptConfig.confirm_text}
              </Button>
            </DialogFooter>
            <p className="mt-3 whitespace-pre-line text-center text-[11px] leading-4 text-muted-foreground/70">
              {paymentPromptConfig.footer_note}
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showInsufficientCreditsNotice}
        onOpenChange={(open) => {
          if (!open) setNoticeDismissed(true);
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
          <DialogFooter>
            <DialogClose asChild>
              <Button
                className="w-full rounded-xl font-bold text-primary-foreground"
                style={{ backgroundColor: pageConfig.button_color }}
              >
                选择套餐
              </Button>
            </DialogClose>
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
