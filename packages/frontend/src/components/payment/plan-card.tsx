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

/*
 * 四档必须一眼分得开，但都收在暖色域内：
 * entry 走中性面，standard 走玫瑰，recommended 走烛光金（主推位最亮），premium 走深玫瑰。
 * 不再用冷紫/靛蓝，避免深夜暗环境里跳出整体色温。
 */
const VARIANT_STYLES: Record<PaymentPlanVariant, VariantStyle> = {
  entry: {
    Icon: Star,
    container: 'bg-card border border-border backdrop-blur-md',
    iconWrap: 'bg-secondary text-muted-foreground',
    creditsText: 'text-foreground',
    priceText: 'text-foreground/80',
    badgeClass: '',
    highlightKind: 'plain',
    highlightColor: 'text-muted-foreground',
  },
  standard: {
    Icon: Zap,
    container:
      'bg-rose/[0.07] border border-rose/30 backdrop-blur-md shadow-[0_0_15px_hsl(var(--rose)/0.1)]',
    iconWrap: 'bg-rose/20 text-rose border border-rose/20',
    creditsText: 'text-foreground',
    priceText: 'text-rose',
    badgeClass:
      'absolute top-0 right-0 bg-rose text-primary-foreground text-[9px] font-bold px-1.5 py-0.5 rounded-bl-xl z-10',
    highlightKind: 'plain',
    highlightColor: 'text-rose',
  },
  recommended: {
    Icon: Sparkles,
    container:
      'bg-primary/[0.08] border border-primary/50 backdrop-blur-xl shadow-[0_0_20px_hsl(var(--glow)/0.18),inset_0_0_15px_hsl(var(--glow)/0.06)]',
    iconWrap:
      'bg-primary text-primary-foreground shadow-md shadow-[0_4px_12px_hsl(var(--glow)/0.4)]',
    creditsText: 'text-transparent bg-clip-text bg-gradient-to-b from-foreground to-primary',
    priceText: 'text-primary',
    badgeClass:
      'absolute top-0 right-0 bg-gradient-to-r from-primary to-warn text-primary-foreground text-[9px] font-bold px-2 py-0.5 rounded-bl-xl z-10',
    highlightKind: 'plain',
    highlightColor: 'text-primary',
  },
  premium: {
    Icon: Crown,
    container:
      'bg-[linear-gradient(135deg,hsl(var(--rose)/0.16)_0%,hsl(var(--rose-fill)/0.16)_100%)] border border-rose-fill/45 backdrop-blur-md shadow-[0_0_20px_hsl(var(--rose-fill)/0.18)]',
    iconWrap:
      'bg-gradient-to-br from-rose to-rose-fill text-primary-foreground shadow-md shadow-[0_4px_12px_hsl(var(--rose-fill)/0.4)]',
    creditsText: 'text-transparent bg-clip-text bg-gradient-to-b from-foreground to-rose',
    priceText: 'text-rose',
    badgeClass:
      'absolute top-0 right-0 bg-gradient-to-bl from-rose via-rose-fill to-primary text-primary-foreground text-[9px] font-black px-2 py-0.5 rounded-bl-xl z-10',
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
        <span className="rounded border border-primary/50 bg-background/60 px-1 text-[9px] font-black italic text-primary">
          SVIP
        </span>
      );
    }
    if (plan.variant === 'standard' && percent > 0) {
      return (
        <span className="rounded border border-rose/50 bg-rose/10 px-1 text-[9px] font-bold text-rose">
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
        'group relative w-full overflow-hidden rounded-[20px] text-left transition-all duration-300 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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
                    <span className="rounded-[4px] bg-gradient-to-r from-rose to-rose-fill px-1.5 py-0.5 text-[10px] font-black text-primary-foreground shadow-sm">
                      {plan.highlight_text}
                    </span>
                    {percent > 0 ? (
                      <span className="rounded-[4px] bg-rose/20 px-1.5 py-0.5 text-[10px] font-bold text-rose">
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
              <div className="mt-1 truncate text-[10px] leading-tight text-muted-foreground/80">
                {plan.sub_copy}
              </div>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 text-right leading-tight">
          {plan.original_price_cents !== null ? (
            <div className="relative inline-block font-mono text-[9px] text-muted-foreground/80 opacity-70">
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
