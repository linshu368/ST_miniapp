'use client';

import { Suspense, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Gem,
  History,
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
  const inviteEntry = useInviteEntryStatusQuery();
  const inviteEntryEnabled = inviteEntry.data?.entry_enabled === true;

  const goInviteCenter = useCallback(() => router.push('/profile/invite'), [router]);

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [paymentType, setPaymentType] = useState<PaymentType>('wxpay');
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [paymentPromptOpen, setPaymentPromptOpen] = useState(false);
  const [preparedPayment, setPreparedPayment] = useState<CreatePaymentOrderData | null>(null);

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

  const openCreatedPayment = useCallback(
    (result: CreatePaymentOrderData) => {
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
    },
    [router, returnTo]
  );

  const handleSubmit = useCallback(async () => {
    if (!selectedPlan || createOrder.isPending) return;
    impact('light');
    try {
      // 用户关闭 VPN 前先完成下单；弹窗出现即表示支付地址已经准备好。
      const result = await createOrder.mutateAsync({
        plan_id: selectedPlan.id,
        payment_type: paymentType,
      });
      if (paymentPromptConfig.enabled) {
        setPreparedPayment(result);
        setPaymentPromptOpen(true);
        return;
      }
      openCreatedPayment(result);
    } catch {
      notification('error');
    }
  }, [
    selectedPlan,
    createOrder,
    impact,
    paymentPromptConfig.enabled,
    paymentType,
    openCreatedPayment,
    notification,
  ]);

  const handleConfirmPayment = useCallback(() => {
    if (!preparedPayment) return;
    setPaymentPromptOpen(false);
    setPreparedPayment(null);
    openCreatedPayment(preparedPayment);
  }, [preparedPayment, openCreatedPayment]);

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

          {/* 邀请快捷入口：紧挨着套餐列表，保持相同的 gap-3，并对齐高档套餐卡高度 */}
          {inviteEntryEnabled ? (
            <button
              type="button"
              onClick={goInviteCenter}
              className="relative flex h-[86px] w-full items-center gap-3 overflow-hidden rounded-xl border border-[#ec4899] bg-[#ec4899] px-4 text-left shadow-[0_0_26px_rgba(236,72,153,0.32)] transition hover:opacity-80"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose to-rose-fill text-primary-foreground shadow-md shadow-[0_4px_12px_hsl(var(--rose-fill)/0.45)]">
                <Gem className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-black text-foreground">
                  邀请好友得 2200 星尘
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
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
      <Dialog open={paymentPromptOpen} onOpenChange={handlePaymentPromptOpenChange}>
        <DialogContent
          className="w-[calc(100%-2rem)] max-w-sm overflow-hidden rounded-3xl border-2 bg-popover p-0 text-popover-foreground"
          style={{ borderColor: paymentPromptConfig.accent_color }}
        >
          <div
            className="h-1.5 w-full"
            style={{ backgroundColor: paymentPromptConfig.accent_color }}
          />
          <div className="px-5 pb-6 pt-5">
            <DialogHeader className="items-center text-center">
              <div className="flex w-full flex-col gap-3">
                {[
                  { id: 1, before: '第一步：请关闭VPN' },
                  { id: 2, before: '第二步：请', emphasis: '直接截图', after: '保存支付码' },
                  { id: 3, before: '第三步：', emphasis: '手动打开', after: '微信扫码支付' },
                ].map((step) => (
                  <div
                    key={step.id}
                    className="w-full rounded-xl border border-[#3f3f46] bg-[#262626] px-[14px] py-[15px] text-center text-[15px] font-[750] leading-[22px] text-[#fde68a] dark:text-[#b45309]"
                  >
                    {step.before}
                    {step.emphasis ? (
                      <span
                        className="font-[900]"
                        style={{ color: paymentPromptConfig.accent_color }}
                      >
                        {step.emphasis}
                      </span>
                    ) : null}
                    {step.after}
                  </div>
                ))}
              </div>
            </DialogHeader>
            <DialogFooter className="mt-4 border-t border-[#3f3f46] pt-4">
              <Button
                className="mx-auto min-h-[46px] w-fit rounded-xl border-0 px-6 font-black text-[#171717] hover:opacity-90"
                style={{ backgroundColor: paymentPromptConfig.accent_color }}
                disabled={!preparedPayment}
                onClick={handleConfirmPayment}
              >
                已关闭VPN，去截图保存二维码
              </Button>
            </DialogFooter>
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
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            <DialogClose asChild>
              <Button
                className="w-full rounded-xl font-bold text-primary-foreground"
                style={{ backgroundColor: pageConfig.button_color }}
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
