import type { VipPlan, VipStatus } from '@miniapp/shared';
import { Crown, Sparkles, Gift, TicketPercent, Zap } from 'lucide-react';

import { formatNumber } from '@/lib/utils/payment';
import { vipPlanRewardLabel } from '@/lib/vip/rewards';
import { vipEntryExpiryLabel } from '@/lib/vip/presentation';

/** 主利益直接使用月卡发布值；加载失败时不臆造赠送额度。 */
export function VipBenefitArt({
  monthlyPlan,
  status,
}: {
  monthlyPlan: VipPlan | undefined;
  status: VipStatus | undefined;
}) {
  const bonus = (monthlyPlan?.bonus_credits ?? 0) + (monthlyPlan?.bonus_main_credits ?? 0);
  if (status?.active) {
    return (
      <section
        aria-label="我的尊享会员"
        className="relative overflow-hidden rounded-[26px] border border-primary/50 bg-[linear-gradient(120deg,#493724,#2b231d_60%,#211d1b)] p-5 shadow-[inset_0_1px_0_rgba(255,227,180,0.15),0_10px_36px_rgba(0,0,0,0.15)]"
      >
        <Crown
          aria-hidden
          className="pointer-events-none absolute -right-3 top-6 size-40 -rotate-12 text-primary/[0.06]"
        />
        <div className="relative">
          <p className="flex items-center gap-2 text-[11px] font-bold tracking-[0.16em] text-primary">
            <Crown className="size-4" aria-hidden />
            秘境 · VIP
            <span className="ml-auto rounded-full border border-primary/30 px-2 py-0.5 text-[9px] tracking-normal">
              权益生效中
            </span>
          </p>
          <h2 className="mt-7 text-[32px] font-semibold tracking-wide text-[#f3d7af]">尊享会员</h2>
          <p className="mt-1.5 text-[11px] text-[#c8b195]">专属身份已点亮，尽享每一次相遇</p>
          <div className="mt-6 flex items-end justify-between gap-3 border-t border-primary/20 pt-3 text-[#dcc4a4]">
            <span className="text-[10px] leading-5">
              {vipEntryExpiryLabel(status) ?? '会员权益已开启'}
            </span>
            <span className="shrink-0 text-xs">
              剩余{' '}
              <span className="text-xl font-semibold tabular-nums text-primary">
                {status.remaining_days}
              </span>{' '}
              天
            </span>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section
      aria-label="会员月卡赠礼"
      className="vip-benefit-frame relative overflow-hidden rounded-[26px] p-[1.5px] shadow-[0_0_24px_rgba(215,174,100,0.12)]"
    >
      <div className="relative overflow-hidden rounded-[25px] bg-[#261e17] px-5 py-5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(230,184,93,0.16),transparent_70%)]"
        />
        <div className="relative">
          <p className="flex items-center gap-2 text-xs font-bold tracking-wide text-primary">
            <Crown className="size-4" aria-hidden />
            VIP 月卡
          </p>
          <p className="mt-4 text-sm font-semibold text-foreground/90">
            {bonus > 0 ? '开通即送，尽兴开聊' : '把喜欢的故事，聊得更尽兴'}
          </p>
          {bonus > 0 ? (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-primary">
              <span className="text-[52px] font-bold leading-[1.15] tabular-nums tracking-tight">
                {formatNumber(bonus)}
              </span>
              <span className="text-[15px] font-semibold">星尘</span>
            </div>
          ) : (
            <h2 className="mt-2 text-[28px] font-bold text-primary">会员专享权益</h2>
          )}
          {(monthlyPlan?.bonus_main_credits ?? 0) > 0 ? (
            <p className="mt-3 text-xs leading-5 text-primary/90">通用星尘可用于中高级模型</p>
          ) : null}
          <p className="mt-3 flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
            <Sparkles className="size-3.5 shrink-0 text-primary/80" aria-hidden />
            {monthlyPlan && bonus > 0
              ? vipPlanRewardLabel(monthlyPlan)
              : '月卡内容以当前发布的套餐为准'}
          </p>
        </div>
      </div>
    </section>
  );
}

export function VipDailyBenefits({
  active,
  benefits,
  discountLabel,
}: {
  active: boolean;
  benefits: VipStatus['benefits'];
  discountLabel: string | null;
}) {
  return (
    <section aria-label="会员专享权益">
      <h2 className="mb-3 px-1 text-sm font-bold">
        {active ? '你的会员权益已生效' : '再享三项会员权益'}
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
            {benefits ? formatNumber(benefits.checkin_vip_credits) : '—'}
            <span className="ml-0.5 whitespace-nowrap text-[9px] font-medium">星尘/天</span>
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {benefits && (benefits.checkin_main_credits ?? 0) > 0
              ? `${formatNumber(benefits.checkin_bonus_credits ?? 0)} 专项＋${formatNumber(benefits.checkin_main_credits ?? 0)} 通用`
              : '每日签到奖励'}
          </p>
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
  );
}
