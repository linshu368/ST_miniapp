'use client';

import { Crown, Sparkles, Star, Zap, type LucideIcon } from 'lucide-react';
import type { PaymentPlan, PaymentPlanVariant } from '@miniapp/shared';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { bonusPercent, formatNumber, formatYuan, formatYuanShort } from '@/lib/utils/payment';

interface PlanCardProps {
  plan: PaymentPlan;
  selected: boolean;
  selectedColor: string;
  badgeColor: string;
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
    container: 'bg-card border border-border backdrop-blur-md',
    iconWrap: 'bg-muted text-muted-foreground',
    creditsText: 'text-foreground',
    priceText: 'text-foreground',
    badgeClass: '',
    highlightKind: 'plain',
    highlightColor: 'text-muted-foreground',
  },
  standard: {
    Icon: Zap,
    container: 'bg-card border border-primary/20 backdrop-blur-md',
    iconWrap: 'bg-primary/10 text-primary border border-primary/15',
    creditsText: 'text-foreground',
    priceText: 'text-primary',
    badgeClass:
      'absolute top-0 right-0 bg-primary text-primary-foreground text-[9px] font-bold px-1.5 py-0.5 rounded-bl-xl z-10',
    highlightKind: 'plain',
    highlightColor: 'text-primary',
  },
  recommended: {
    Icon: Sparkles,
    container: 'bg-card border border-primary/40 backdrop-blur-xl shadow-lg shadow-primary/10',
    iconWrap: 'bg-primary text-primary-foreground shadow-md shadow-primary/20',
    creditsText: 'text-primary',
    priceText: 'text-primary',
    badgeClass:
      'absolute top-0 right-0 bg-primary text-primary-foreground text-[9px] font-bold px-2 py-0.5 rounded-bl-xl z-10',
    highlightKind: 'plain',
    highlightColor: 'text-primary',
  },
  premium: {
    Icon: Crown,
    container:
      'bg-gradient-to-br from-primary/10 to-teal-500/5 border border-primary/35 backdrop-blur-md',
    iconWrap:
      'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md shadow-primary/20',
    creditsText: 'text-primary',
    priceText: 'text-primary',
    badgeClass:
      'absolute top-0 right-0 bg-gradient-to-bl from-emerald-500 to-teal-700 text-white text-[9px] font-black px-2 py-0.5 rounded-bl-xl z-10',
    highlightKind: 'pill-red',
    highlightColor: '',
  },
};

export function PlanCard({ plan, selected, selectedColor, badgeColor, onSelect }: PlanCardProps) {
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
        <span className="rounded border border-primary/30 bg-primary/10 px-1 text-[9px] font-bold text-primary">
          +{percent}% 赠送
        </span>
      );
    }
    return null;
  })();

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onSelect(plan.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(plan.id);
        }
      }}
      aria-pressed={selected}
      className={cn(
        'group relative w-full cursor-pointer overflow-hidden rounded-[20px] text-left outline-none transition-all duration-300 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        style.container,
        selected && 'border-transparent ring-2 ring-offset-2 ring-offset-background'
      )}
      style={
        selected
          ? ({
              borderColor: selectedColor,
              boxShadow: `0 0 28px ${selectedColor}45`,
              '--tw-ring-color': selectedColor,
            } as React.CSSProperties)
          : undefined
      }
    >
      {plan.badge_text ? (
        <span className={style.badgeClass} style={{ background: badgeColor, color: '#fff' }}>
          {plan.badge_text}
        </span>
      ) : null}

      <CardContent className="p-3 relative z-10 flex items-start justify-between gap-3">
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
              <span className="text-[10px] text-muted-foreground">星尘</span>
              {inlineChip}
            </div>

            {/* Line 2: 高亮文案（如有） */}
            {plan.highlight_text ? (
              <div className="mt-1 flex items-center gap-1.5">
                {style.highlightKind === 'pill-red' ? (
                  <>
                    <span className="rounded-[4px] bg-primary px-1.5 py-0.5 text-[10px] font-black text-primary-foreground shadow-sm">
                      {plan.highlight_text}
                    </span>
                    {percent > 0 ? (
                      <span className="rounded-[4px] bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
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
              <div className="mt-1 truncate text-[10px] leading-tight text-muted-foreground">
                {plan.sub_copy}
              </div>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 text-right leading-tight">
          {plan.original_price_cents !== null ? (
            <div className="relative inline-block font-mono text-[9px] text-muted-foreground opacity-70">
              <span>¥{formatYuan(plan.original_price_cents)}</span>
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-px w-full -rotate-[10deg] bg-muted-foreground"
              />
            </div>
          ) : null}
          <div className={cn('mt-0.5 font-mono text-base font-bold', style.priceText)}>
            ¥{formatYuanShort(plan.price_cents)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
