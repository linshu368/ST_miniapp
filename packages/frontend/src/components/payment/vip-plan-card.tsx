'use client';

import type { VipPlan } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort } from '@/lib/utils/payment';

export function VipPlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: VipPlan;
  selected: boolean;
  onSelect: (planId: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(plan.id)}
      className={cn(
        'w-full rounded-[22px] border px-4 py-3.5 text-left transition',
        selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-secondary'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-bold text-foreground">{plan.title}</span>
            {plan.badge_text ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary">
                {plan.badge_text}
              </span>
            ) : null}
          </div>
          {plan.description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {plan.description}
            </p>
          ) : null}
          <p className="mt-2 text-[12px] text-muted-foreground">
            {plan.duration_days} 天
            {plan.bonus_credits > 0
              ? ` · 赠送 ${formatNumber(plan.bonus_credits)} 专项星尘`
              : ' · 不赠送专项星尘'}
          </p>
          {plan.available ? null : (
            <p className="mt-1 text-[12px] text-muted-foreground">暂未开放购买</p>
          )}
        </div>
        <span className="shrink-0 text-[18px] font-black tabular-nums text-primary">
          ¥{formatYuanShort(plan.price_cents)}
        </span>
      </div>
    </button>
  );
}
