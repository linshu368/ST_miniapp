'use client';

import type { PaymentPlan } from '@miniapp/shared';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort, totalCredits } from '@/lib/utils/payment';

interface PlanCardProps {
  plan: PaymentPlan;
  selected: boolean;
  selectedColor: string;
  badgeColor: string;
  onSelect: (planId: string) => void;
}

export function PlanCard({ plan, selected, selectedColor, badgeColor, onSelect }: PlanCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(plan.id)}
      className={cn(
        'relative flex min-h-[142px] min-w-0 flex-col overflow-hidden rounded-[22px] border bg-card px-3.5 pb-3.5 pt-6 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        selected ? 'bg-primary/[0.07]' : 'border-border hover:border-primary/40'
      )}
      style={
        selected
          ? { borderColor: selectedColor, boxShadow: `inset 0 0 0 1px ${selectedColor}` }
          : undefined
      }
    >
      {plan.badge_text ? (
        <span
          className="absolute right-0 top-0 max-w-full truncate rounded-bl-xl px-2.5 py-0.5 text-[9px] font-semibold text-primary-foreground"
          style={{ backgroundColor: badgeColor }}
        >
          {plan.badge_text}
        </span>
      ) : null}
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[23px] font-bold leading-7 tabular-nums tracking-tight">
          {formatNumber(totalCredits(plan))}
        </span>
        <span className="text-[10px] text-muted-foreground">星尘</span>
      </span>
      <span className="mt-1 block text-[10px] leading-4 text-muted-foreground">
        {plan.bonus_credits > 0
          ? `含赠送 ${formatNumber(plan.bonus_credits)} 星尘`
          : plan.sub_copy || '为喜欢的故事续上星光'}
      </span>
      {plan.highlight_text ? (
        <span className="mt-1 line-clamp-2 text-[10px] leading-4 text-primary">
          {plan.highlight_text}
        </span>
      ) : null}
      <span className="mt-auto flex items-end justify-between gap-1 pt-3">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[17px] font-bold tabular-nums text-primary">
            ¥{formatYuanShort(plan.price_cents)}
          </span>
          {plan.original_price_cents !== null && plan.original_price_cents > plan.price_cents ? (
            <span className="text-[10px] tabular-nums text-muted-foreground line-through">
              ¥{formatYuanShort(plan.original_price_cents)}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded-full border',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/30'
          )}
        >
          {selected ? <Check className="size-3" /> : null}
        </span>
      </span>
    </button>
  );
}
