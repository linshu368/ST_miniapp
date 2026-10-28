'use client';

import type { PaymentPlan } from '@miniapp/shared';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort, savingsCents, totalCredits } from '@/lib/utils/payment';

interface PlanCardProps {
  plan: PaymentPlan;
  selected: boolean;
  selectedColor: string;
  badgeColor: string;
  disabled?: boolean;
  onSelect: (planId: string) => void;
}

export function PlanCard({
  plan,
  selected,
  selectedColor,
  badgeColor,
  disabled,
  onSelect,
}: PlanCardProps) {
  // 省额只认已配置的同一套餐原价，不把专项赠送折算成通用星尘或现金。
  const savings = savingsCents(plan);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(plan.id)}
      className={cn(
        'group relative flex min-h-[158px] min-w-0 flex-col rounded-[18px] border px-3.5 pb-3.5 pt-3.5 text-left transition-[background-color,border-color,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7bfa1] disabled:opacity-60 motion-reduce:transition-none',
        selected ? '' : 'border-white/[0.08] bg-[#242124] hover:border-white/20'
      )}
      style={
        selected
          ? {
              borderColor: selectedColor,
              backgroundColor: `${selectedColor}14`,
              boxShadow: `inset 0 0 0 0.5px ${selectedColor}`,
            }
          : undefined
      }
    >
      {plan.badge_text ? (
        <span
          className="absolute -top-2.5 right-3 max-w-[calc(100%-1.5rem)] truncate rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4"
          style={{ backgroundColor: '#302a29', color: badgeColor, borderColor: `${badgeColor}40` }}
        >
          {plan.badge_text}
        </span>
      ) : null}
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-[10px] tracking-wide text-[#bbaeaa]">到账星尘</span>
        <span
          aria-hidden
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded-full border',
            selected ? 'text-[#211c18]' : 'border-white/20'
          )}
          style={
            selected ? { backgroundColor: selectedColor, borderColor: selectedColor } : undefined
          }
        >
          {selected ? <Check className="size-3" /> : null}
        </span>
      </span>
      <span className="mt-1 block text-[30px] font-semibold leading-9 tabular-nums tracking-[-0.045em] text-[#f6eee3] max-[360px]:text-[26px]">
        {formatNumber(totalCredits(plan))}
      </span>
      {plan.bonus_credits > 0 ? (
        <span className="mt-2 flex w-full flex-wrap items-baseline gap-x-1 rounded-lg border border-[#e4bf8c]/10 bg-[#dbb581]/10 px-2 py-1.5 text-[#e8c794]">
          <span className="text-[10px]">含赠</span>
          <strong className="text-[16px] font-semibold leading-5 tabular-nums tracking-tight">
            {formatNumber(plan.bonus_credits)}
          </strong>
          <span className="text-[10px] max-[360px]:sr-only">星尘</span>
        </span>
      ) : (
        <span className="mt-2 min-h-8 text-[11px] leading-5 text-[#b9aaa3]">
          {plan.highlight_text || plan.sub_copy || '按需补充，自在体验'}
        </span>
      )}
      <span className="mt-auto flex w-full flex-wrap items-center justify-between gap-x-1.5 gap-y-1 pt-3">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[13px] font-medium tabular-nums text-[#c6bbb4]">
            ¥{formatYuanShort(plan.price_cents)}
          </span>
          {savings > 0 && plan.original_price_cents !== null ? (
            <span className="text-[10px] tabular-nums text-[#9c9191] line-through">
              ¥{formatYuanShort(plan.original_price_cents)}
            </span>
          ) : null}
        </span>
        {savings > 0 ? (
          <span className="text-[11px] font-medium tabular-nums text-[#e8c794]">
            省 ¥{formatYuanShort(savings)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
