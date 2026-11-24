'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, Clock3 } from 'lucide-react';
import type { PublicFreeZone, PublicFreeZoneModel, PublicModelCatalogTier } from '@miniapp/shared';

import {
  freeZoneHasTurnLimits,
  freeZoneModelResetsAt,
  freeZoneRulesText,
  freeZoneStatusText,
  formatFreeZoneTime,
  isFreeZoneOpen,
  isVipZone,
} from '@/lib/free-zone';
import { cn } from '@/lib/utils';

const TIER_FALLBACK: Record<string, { label: string; color: string }> = {
  light: { label: '轻量', color: '#4ade80' },
  standard: { label: '标准', color: '#818cf8' },
  premium: { label: '旗舰', color: '#c084fc' },
};

/**
 * 「畅聊」栏目：放在轻量/标准/旗舰上面，骨架沿用档位卡，用畅聊专用强调色（--free-zone，和主色金区分开），开放时描边加一道光带。
 * 开放写结束时间；未开放默认折叠，卡头照样显示规则（也是宣传位），点开能预览、不能选。
 * 福利期外按身份展示：新人试用、会员（带 VIP 标签）、非会员（会员专享 + 卡内开通按钮）。
 */
export function ChatFreeZoneSection({
  zone,
  tiers,
  selectedId,
  selecting,
  onSelect,
  onClosedTap,
  onLimitTap,
  onUpgrade,
}: {
  zone: PublicFreeZone;
  tiers: PublicModelCatalogTier[];
  selectedId: string;
  selecting: boolean;
  onSelect: (modelId: string) => void;
  onClosedTap: () => void;
  /** 点了今天已用满的模型 */
  onLimitTap: (model: PublicFreeZoneModel) => void;
  /** 非会员点「开通 VIP」 */
  onUpgrade: () => void;
}) {
  const open = isFreeZoneOpen(zone);
  // 用户手动开合优先；开放状态一变就回到默认（开放展开、未开放折叠）。
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [open]);
  const collapsed = override ?? !open;

  return (
    <section
      data-free-zone={zone.state}
      className={cn(
        'relative overflow-hidden rounded-2xl border',
        open
          ? 'border-free-zone/50 bg-[linear-gradient(165deg,hsl(var(--free-zone)/0.16)_0%,hsl(var(--card))_55%)]'
          : 'border-free-zone/20 bg-[linear-gradient(165deg,hsl(var(--free-zone)/0.06)_0%,hsl(var(--card))_55%)]'
      )}
    >
      {open ? (
        <span
          className="free-zone-sweep pointer-events-none absolute inset-x-0 top-0 h-24 overflow-hidden"
          aria-hidden
        />
      ) : null}
      <FreeZoneHeader
        zone={zone}
        open={open}
        collapsed={collapsed}
        onToggle={() => setOverride(!collapsed)}
      />
      {zone.state === 'vip_only' ? (
        <div className="relative z-10 px-4 pb-3.5">
          <button
            type="button"
            onClick={onUpgrade}
            className="min-h-11 w-full rounded-xl bg-[linear-gradient(180deg,#f2d4a7,#d7ac78_60%,#c4935f)] text-[14.5px] font-extrabold text-[#2a1c10] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-transform active:scale-[0.98]"
          >
            {zone.access && zone.access.vip_welcome_days > 0
              ? `开通 VIP，立享 ${zone.access.vip_welcome_days} 天畅聊`
              : '开通 VIP，每周畅聊'}
          </button>
        </div>
      ) : null}
      {collapsed || zone.models.length === 0 ? null : (
        <div className="divide-y divide-border border-t border-border">
          {zone.models.map((model) => {
            const resetsAt = open ? freeZoneModelResetsAt(model) : null;
            return (
              <FreeZoneModelRow
                key={model.id}
                model={model}
                open={open}
                resetsAt={resetsAt}
                active={open && model.id === selectedId}
                selecting={selecting}
                tier={
                  tiers.find((item) => item.key === model.benchmark_tier) ??
                  TIER_FALLBACK[model.benchmark_tier]
                }
                onClick={() =>
                  !open ? onClosedTap() : resetsAt ? onLimitTap(model) : onSelect(model.id)
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function FreeZoneHeader({
  zone,
  open,
  collapsed,
  onToggle,
}: {
  zone: PublicFreeZone;
  open: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const rules = freeZoneRulesText(zone);
  const vipOnly = zone.state === 'vip_only';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="relative z-10 block w-full px-4 pb-3 pt-3.5 text-left"
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            'shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none text-white dark:text-[#090b12]',
            open ? 'bg-free-zone' : 'bg-free-zone/60'
          )}
        >
          畅聊
        </span>
        <span className="min-w-0 truncate text-[15px] font-semibold text-foreground">免费畅聊</span>
        {isVipZone(zone) ? (
          <span className="shrink-0 rounded-md border border-primary/50 px-1.5 py-px text-[10.5px] font-bold leading-tight text-primary">
            VIP
          </span>
        ) : null}
        <span className="flex-1" />
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            collapsed && '-rotate-90'
          )}
          aria-hidden
        />
      </span>
      <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'rounded-md px-2 py-1 text-[10.5px] font-medium leading-none',
            open ? 'bg-free-zone/15 text-free-zone' : 'bg-free-zone/10 text-free-zone/70'
          )}
        >
          每轮 0 星尘
        </span>
        {freeZoneHasTurnLimits(zone) ? null : (
          <span className="rounded-md bg-secondary px-2 py-1 dark:bg-black/20 text-[10.5px] font-medium leading-none text-foreground/75">
            不限次数
          </span>
        )}
        <span className="ml-auto" />
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums',
            open
              ? 'border-free-zone/45 text-free-zone'
              : vipOnly
                ? 'border-primary/50 text-primary'
                : 'border-border text-muted-foreground'
          )}
        >
          <Clock3 className="size-3" aria-hidden />
          {freeZoneStatusText(zone)}
        </span>
      </span>
      {rules ? (
        <span className="mt-2.5 line-clamp-3 whitespace-pre-line text-[11.5px] leading-[1.6] text-foreground/70">
          {rules}
        </span>
      ) : null}
    </button>
  );
}

/**
 * 未开放、今天已用满时这一行仍可点（给出「何时开放 / 何时恢复」的提示），所以不标 disabled。
 * 用满的行压暗，名字下面写恢复时间。
 */
function FreeZoneModelRow({
  model,
  open,
  resetsAt,
  active,
  selecting,
  tier,
  onClick,
}: {
  model: PublicFreeZoneModel;
  open: boolean;
  /** 这个用户今天已用满：恢复时间 */
  resetsAt: string | null;
  active: boolean;
  selecting: boolean;
  tier: { label: string; color: string } | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={open && selecting}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none',
        active ? 'bg-free-zone/10' : open ? 'hover:bg-secondary' : 'cursor-default'
      )}
    >
      {open ? (
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full border transition-transform',
            active ? 'scale-110 border-transparent bg-free-zone' : 'border-border'
          )}
        >
          {active ? <Check className="size-3.5 text-primary-foreground" aria-hidden /> : null}
        </span>
      ) : (
        <Clock3 className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      )}
      <span className={cn('min-w-0 flex-1', (!open || resetsAt) && 'opacity-55')}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-medium text-foreground">
            {model.display_name}
          </span>
          {tier ? (
            <span
              // 档位色来自运营配置，按深底挑的；白底上只留描边，字用正文色。
              className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-semibold text-foreground/80 dark:text-[color:var(--tier)]"
              style={{ '--tier': tier.color, borderColor: `${tier.color}66` } as CSSProperties}
            >
              {tier.label}
            </span>
          ) : null}
        </span>
        {resetsAt ? (
          <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
            次数已用完 · {formatFreeZoneTime(resetsAt)} 恢复
          </span>
        ) : model.tagline ? (
          <span className="mt-1 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">
            {model.tagline}
          </span>
        ) : null}
      </span>
      <span className={cn('shrink-0 text-right leading-none', (!open || resetsAt) && 'opacity-50')}>
        <span
          className={cn(
            'block text-[13px] font-bold tabular-nums',
            open ? 'text-free-zone' : 'text-free-zone/70'
          )}
        >
          0<span className="ml-0.5 text-[10px] font-medium">星尘</span>
        </span>
        <span className="mt-1 block text-[10px] tabular-nums text-muted-foreground line-through">
          {model.original_credits} 星尘
        </span>
      </span>
    </button>
  );
}
