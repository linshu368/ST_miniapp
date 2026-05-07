'use client';

import { Crown, Sparkles, Star, Zap, type LucideIcon } from 'lucide-react';
import type { PaymentPlan, PaymentPlanVariant } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { bonusPercent, formatNumber, formatYuan, formatYuanShort } from '@/lib/utils/payment';

interface PlanCardProps {
  plan: PaymentPlan;
  selected: boolean;
  onSelect: (planId: string) => void;
}

type VariantStyle = {
  Icon: LucideIcon;
  container: string;
  iconWrap: string;
  creditsText: string;
  priceText: string;
  badgeClass: string;
  /** highlight 行文字颜色 / 处理方式 */
  highlightKind: 'plain' | 'pill-red';
  highlightColor: string;
};

const VARIANT_STYLES: Record<PaymentPlanVariant, VariantStyle> = {
  entry: {
    Icon: Star,
    container: 'bg-slate-900/30 border border-slate-800/80 opacity-80',
    iconWrap: 'bg-slate-800 text-slate-500',
    creditsText: 'text-slate-300',
    priceText: 'text-slate-400/80',
    badgeClass: '',
    highlightKind: 'plain',
    highlightColor: 'text-slate-400',
  },
  standard: {
    Icon: Zap,
    container:
      'bg-slate-900/70 border border-purple-500/50 shadow-[0_0_12px_rgba(168,85,247,0.15)]',
    iconWrap: 'bg-purple-500/20 text-purple-400 border border-purple-500/20',
    creditsText: 'text-white',
    priceText: 'text-purple-200/90',
    badgeClass:
      'absolute top-0 right-0 bg-purple-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-bl-md z-10',
    highlightKind: 'plain',
    highlightColor: 'text-purple-300',
  },
  recommended: {
    Icon: Sparkles,
    container:
      'bg-slate-900 border border-pink-500 shadow-[0_0_20px_rgba(236,72,153,0.3),inset_0_0_14px_rgba(236,72,153,0.08)]',
    iconWrap: 'bg-pink-500 text-white shadow-md shadow-pink-500/40',
    creditsText: 'text-white',
    priceText: 'text-pink-200/90',
    badgeClass:
      'absolute top-0 right-0 bg-gradient-to-r from-pink-600 to-purple-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-bl-md z-10',
    highlightKind: 'plain',
    highlightColor: 'text-pink-400',
  },
  premium: {
    Icon: Crown,
    container:
      'border border-yellow-500/60 bg-yellow-900/15 shadow-[0_0_18px_rgba(234,179,8,0.2)] bg-[linear-gradient(135deg,rgba(234,179,8,0.12)_0%,rgba(0,0,0,0)_100%)]',
    iconWrap:
      'bg-gradient-to-br from-yellow-300 to-yellow-600 text-black shadow-md shadow-yellow-500/40',
    creditsText: 'text-transparent bg-clip-text bg-[linear-gradient(to_bottom,#ffffff,#fde047)]',
    priceText: 'text-yellow-400/90',
    badgeClass:
      'absolute top-0 right-0 bg-gradient-to-bl from-yellow-300 via-yellow-500 to-yellow-600 text-black text-[9px] font-black px-1.5 py-0.5 rounded-bl-md z-10',
    highlightKind: 'pill-red',
    highlightColor: '',
  },
};

export function PlanCard({ plan, selected, onSelect }: PlanCardProps) {
  const style = VARIANT_STYLES[plan.variant];
  const Icon = style.Icon;
  const percent = bonusPercent(plan);
  const displayCredits = plan.credits_amount + plan.bonus_credits;

  // Line 1 的 inline chip：premium 显示 SVIP，standard/其它有赠送时显示 +N%
  const inlineChip: React.ReactNode = (() => {
    if (plan.variant === 'premium') {
      return (
        <span className="rounded border border-yellow-500/50 bg-black/60 px-1 text-[9px] font-black italic text-yellow-500">
          SVIP
        </span>
      );
    }
    if (plan.variant === 'standard' && percent > 0) {
      return (
        <span className="rounded border border-purple-500/50 bg-purple-500/10 px-1 text-[9px] font-bold text-purple-300">
          +{percent}% 赠送
        </span>
      );
    }
    return null;
  })();

  return (
    <button
      type="button"
      onClick={() => onSelect(plan.id)}
      aria-pressed={selected}
      className={cn(
        'group relative w-full overflow-hidden rounded-xl p-3 text-left transition-colors',
        style.container,
        selected && 'ring-2 ring-offset-2 ring-offset-[#0A0A0A] ring-pink-400/80'
      )}
    >
      {plan.badge_text ? <span className={style.badgeClass}>{plan.badge_text}</span> : null}

      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              style.iconWrap
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </div>

          <div className="min-w-0 flex-1">
            {/* Line 1: credits + 星尘 + inline chip */}
            <div className="flex items-baseline gap-1.5">
              <span
                className={cn('text-lg font-black leading-tight tracking-tight', style.creditsText)}
              >
                {formatNumber(displayCredits)}
              </span>
              <span className="text-[10px] text-slate-400">星尘</span>
              {inlineChip}
            </div>

            {/* Line 2: 高亮文案（如有） */}
            {plan.highlight_text ? (
              <div className="mt-1 flex items-center gap-1">
                {style.highlightKind === 'pill-red' ? (
                  <>
                    <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-black text-white shadow-sm shadow-red-500/50">
                      {plan.highlight_text}
                    </span>
                    {percent > 0 ? (
                      <span className="rounded border border-yellow-500/50 bg-yellow-500/10 px-1 text-[9px] font-bold text-yellow-300">
                        多送 {percent}%
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className={cn('text-[11px] font-bold leading-tight', style.highlightColor)}>
                    {plan.highlight_text}
                  </span>
                )}
              </div>
            ) : null}

            {/* Line 3: 副标（如有，自己占一行不截断） */}
            {plan.sub_copy ? (
              <div className="mt-1 truncate text-[10px] leading-tight text-slate-500">
                {plan.sub_copy}
              </div>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 text-right leading-tight">
          {plan.original_price_cents !== null ? (
            <div className="relative inline-block font-mono text-[9px] text-slate-500 opacity-70">
              <span>¥{formatYuan(plan.original_price_cents)}</span>
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-px w-full -rotate-[10deg] bg-slate-400"
              />
            </div>
          ) : null}
          <div className={cn('mt-0.5 font-mono text-base font-bold', style.priceText)}>
            ¥{formatYuanShort(plan.price_cents)}
          </div>
        </div>
      </div>
    </button>
  );
}
