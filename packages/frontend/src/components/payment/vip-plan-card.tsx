'use client';

import type { VipPlan } from '@miniapp/shared';
import { Check, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort } from '@/lib/utils/payment';

export function VipPlanCard({
  plan,
  selected,
  onSelect,
  discountLabel,
}: {
  plan: VipPlan;
  selected: boolean;
  onSelect: (planId: string) => void;
  discountLabel?: string | null;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(plan.id)}
      className={cn(
        'w-full rounded-[20px] border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none',
        selected
          ? 'border-primary/80 bg-gradient-to-br from-primary/10 to-card shadow-[inset_0_0_0_1px_rgba(215,174,100,0.15)]'
          : 'border-border bg-card hover:bg-secondary'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-bold text-foreground">{plan.title}</span>
        <div className="flex items-center gap-4">
          <span className="text-[18px] font-black tabular-nums text-primary">
            ¥{formatYuanShort(plan.price_cents)}
          </span>
          <span
            aria-hidden
            className={cn(
              'flex h-4 w-4 items-center justify-center rounded-full border',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/30'
            )}
          >
            {selected ? <Check className="h-3 w-3" /> : null}
          </span>
        </div>
      </div>
      {plan.description ? (
        <p className="mt-1 text-[11px] leading-relaxed text-foreground/80">{plan.description}</p>
      ) : null}
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {plan.duration_days} 天 ·{' '}
        {plan.bonus_credits > 0 ? `赠 ${formatNumber(plan.bonus_credits)} 专项星尘` : '不赠送星尘'}
        {discountLabel ? ` · 有效期内文本 ${discountLabel}` : ''}
      </p>
      {plan.bonus_credits > 0 ? (
        <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-semibold text-primary">
          <Sparkles className="h-3 w-3" aria-hidden />
          赠送专项 {formatNumber(plan.bonus_credits)} 星尘
        </span>
      ) : plan.badge_text ? (
        <span className="mt-2 inline-block text-[10px] font-semibold text-primary">
          {plan.badge_text}
        </span>
      ) : null}
      {!plan.available ? (
        <p className="mt-1 text-[11px] text-muted-foreground">暂未开放购买</p>
      ) : null}
    </button>
  );
}
