'use client';

import type { VipPlan, VipStatus } from '@miniapp/shared';
import { ChevronRight, Crown, Loader2 } from 'lucide-react';

import { formatNumber, formatYuanShort } from '@/lib/utils/payment';
import { formatDiscountLabel, vipEntryExpiryLabel } from '@/lib/vip/presentation';

/** 入口优先表达月卡赠送，权益与金额始终来自服务端发布的同一套餐。 */
export function VipEntryCard({
  status,
  monthlyPlan,
  loading = false,
  disabled = false,
  onOpen,
}: {
  status: VipStatus | undefined;
  monthlyPlan: VipPlan | undefined;
  loading?: boolean;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const active = status?.active === true;
  const benefits = status?.benefits;
  const discount =
    benefits && benefits.text_discount_rate < 1
      ? formatDiscountLabel(benefits.text_discount_rate)
      : null;
  const extraCheckin = benefits?.checkin_vip_credits;
  const bonus = monthlyPlan?.bonus_credits ?? 0;
  const expiry = vipEntryExpiryLabel(status ?? null);

  if (active) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label="查看 VIP 权益与续费"
        className="relative w-full overflow-hidden rounded-[24px] border border-primary/50 bg-[linear-gradient(115deg,#493724,#2b231d_55%,#211d1b)] p-4 text-left shadow-[inset_0_1px_0_rgba(255,227,180,0.12),0_8px_30px_rgba(0,0,0,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <Crown
          aria-hidden
          className="pointer-events-none absolute -right-3 top-3 size-28 -rotate-12 text-primary/[0.07]"
        />
        <span className="relative flex items-center gap-2 text-primary">
          <span className="grid size-7 place-items-center rounded-full border border-primary/40 bg-primary/10">
            <Crown className="size-4" aria-hidden />
          </span>
          <span className="text-[11px] font-bold tracking-[0.16em]">秘境 · VIP</span>
          <span className="ml-auto flex items-center gap-1 text-[10px]">
            <span className="size-1 rounded-full bg-primary" aria-hidden />
            权益生效中
          </span>
        </span>
        <span className="relative mt-3 block text-[23px] font-semibold tracking-wide text-[#f3d7af]">
          尊享会员
        </span>
        <span className="relative mt-1 block text-[10px] text-[#c8b195]">
          {expiry ?? '你的专属权益已开启'}
        </span>
        <span className="relative mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-primary/15 pt-3 text-[10px] text-[#dcc4a4]">
          {typeof extraCheckin === 'number' && extraCheckin > 0 ? (
            <span>每日签到 {formatNumber(extraCheckin)}</span>
          ) : null}
          {discount ? <span>对话 {discount}</span> : null}
          <span className="ml-auto inline-flex items-center gap-0.5 text-primary">
            会员中心
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={loading || disabled}
      aria-label={active ? '查看 VIP 权益与续费' : '开通 VIP，查看月卡权益'}
      className="relative w-full overflow-hidden rounded-[24px] border border-primary/30 bg-[linear-gradient(115deg,hsl(var(--primary)/0.16),hsl(var(--card))_85%)] px-4 py-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none"
    >
      <span className="flex items-center gap-2 text-primary">
        <Crown className="size-4" aria-hidden />
        <span className="text-xs font-bold">VIP 月卡</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {active ? '续费享赠礼' : '会员开通礼'}
        </span>
      </span>
      <span className="mt-3 block text-[11px] text-foreground/80">
        {bonus > 0 ? (active ? '续费再赠' : '开通即送') : '解锁会员专属权益'}
      </span>
      <span className="mt-0.5 flex items-end justify-between gap-2">
        <span className="min-w-0">
          {bonus > 0 ? (
            <span className="block text-primary">
              <span className="text-[34px] font-bold leading-10 tabular-nums tracking-tight">
                {formatNumber(bonus)}
              </span>
              <span className="ml-1.5 text-[11px] font-semibold">专项星尘</span>
            </span>
          ) : (
            <span className="block text-lg font-bold">把喜欢的故事，聊得更尽兴</span>
          )}
        </span>
        <span className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-primary px-3 text-[11px] font-bold text-primary-foreground">
          {loading || disabled ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          {active ? '续费 VIP' : '开通 VIP'}
          <ChevronRight className="size-3.5" aria-hidden />
        </span>
      </span>
      <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-5 text-foreground/80">
        {typeof extraCheckin === 'number' && extraCheckin > 0 ? (
          <span>签到每天 {formatNumber(extraCheckin)}</span>
        ) : null}
        {discount ? <span>全模型对话 {discount}</span> : null}
        {!benefits ? <span>{loading ? '正在读取会员权益…' : '查看完整月卡权益'}</span> : null}
      </span>
      <span className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] leading-4 text-muted-foreground">
        <span>
          {active
            ? (expiry ?? '查看会员详情')
            : bonus > 0
              ? '专项星尘可用于轻量模型对话'
              : '查看月卡内容与专属权益'}
        </span>
        {monthlyPlan ? (
          <span>
            ¥{formatYuanShort(monthlyPlan.price_cents)} / {monthlyPlan.duration_days} 天
          </span>
        ) : null}
      </span>
    </button>
  );
}
