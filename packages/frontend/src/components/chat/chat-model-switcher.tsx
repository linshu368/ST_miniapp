'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Lock, Sparkles } from 'lucide-react';
import type { PublicModelCatalogTier } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiClientError } from '@/lib/api/client';
import { useModelCatalogQuery, useSelectModelMutation } from '@/lib/api/models';
import { redirectToRecharge } from '@/lib/recharge-redirect';
import { getReplayLifecycle } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import {
  billingFailureAction,
  formatTierQuote,
  MAIN_WALLET_NOTICE,
  modelSwitchFeedback,
  publishedDiscountRate,
  formatDiscountLabel,
} from '@/lib/vip/presentation';

/**
 * 切换生成模型。版式照搬原版的 ModelTierSwitcher：当前引擎条、可折叠档位、
 * 限量免费标、完整换行的档位说明。数据全部来自运营平台下发的模型目录。
 *
 * 走 POST /api/v1/models/select 而不是 PATCH /api/v1/generation-config——
 * 后者只收三个 pref_* 字段，模型字段会被 400 掉；而且 select 那条路由带着
 * 「切到付费模型前先查余额」的闸门，绕过去就等于把闸门拆了。
 */
export function ChatModelSwitcher({
  returnTo,
  onSwitched,
  generating = false,
  freeRoundActive = false,
}: {
  returnTo: string;
  /** 切换成功后通知外层收起面板 */
  onSwitched?: () => void;
  generating?: boolean;
  freeRoundActive?: boolean;
}) {
  const router = useRouter();
  const { data, isLoading, isFetching } = useModelCatalogQuery();
  const selectModel = useSelectModelMutation();
  const [error, setError] = useState<string | null>(null);
  const [walletAction, setWalletAction] = useState<'recharge' | null>(null);
  const [lockedTierKey, setLockedTierKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const latestSelectRef = useRef<string | null>(null);

  const selectedId = data?.selected_model_id ?? '';
  const allModels = data?.catalog.tiers.flatMap((tier) => tier.models) ?? [];
  const selectedModel =
    allModels.find((model) => model.id === selectedId) ??
    allModels.find((model) => model.id === data?.catalog.default_model_id);
  const selectedTier = data?.catalog.tiers.find((tier) =>
    tier.models.some((model) => model.id === selectedModel?.id)
  );

  const handleSelect = async (modelId: string) => {
    if (modelId === selectedId) return;
    const tier = data?.catalog.tiers.find((item) =>
      item.models.some((model) => model.id === modelId)
    );
    if (tier?.locked) {
      setLockedTierKey(tier.key);
      return;
    }
    latestSelectRef.current = modelId;
    setError(null);
    setWalletAction(null);
    setFeedback(null);
    try {
      await selectModel.mutateAsync({ model_id: modelId });
      if (latestSelectRef.current !== modelId) return;
      try {
        getReplayLifecycle().updateSessionProperties({ selectedModelId: modelId });
      } catch {
        // 属性更新失败不阻断选模型
      }
      setFeedback(modelSwitchFeedback(generating));
      if (onSwitched) window.setTimeout(onSwitched, generating ? 1600 : 250);
    } catch (err) {
      if (latestSelectRef.current !== modelId) return;
      const code = err instanceof ApiClientError ? err.code : undefined;
      const action = billingFailureAction(code);
      if (action.type === 'vip') {
        router.push('/vip');
        return;
      }
      if (action.type === 'recharge') {
        void redirectToRecharge(router, { returnTo, triggerSource: 'model_switch' });
        return;
      }
      if (action.type === 'main_wallet') {
        setWalletAction('recharge');
        setError(MAIN_WALLET_NOTICE);
        return;
      }
      setError('该模型暂不可用');
    }
  };

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-20 animate-pulse rounded-2xl bg-card" />
        ))}
      </div>
    );
  }

  if (!data || data.catalog.tiers.length === 0) {
    return <p className="py-8 text-center text-[13px] text-muted-foreground">暂时没有可用模型</p>;
  }

  const discountLabel = formatDiscountLabel(
    publishedDiscountRate(data.catalog.tiers) ?? Number.NaN
  );
  const pricedTiers = data.catalog.tiers.filter(
    (tier) => tier.key === 'standard' || tier.key === 'premium'
  );

  return (
    <div className="space-y-4">
      {data.vip_status?.active ? (
        <p className="rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-[12px] leading-relaxed text-primary">
          VIP 有效期剩余 {data.vip_status.remaining_days} 天
          {discountLabel ? ` · 文本折扣 ${discountLabel} 已生效` : ''}
        </p>
      ) : null}
      {freeRoundActive ? (
        <p className="rounded-2xl border border-success/30 bg-success/10 px-3 py-2 text-[12px] leading-relaxed text-success">
          当前角色仍有免费轮次。本轮免费，不叠加折扣。
        </p>
      ) : null}
      <div className="model-current-shimmer relative overflow-hidden rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3.5">
        <div className="relative z-10 flex items-center gap-3">
          <span
            className="model-tier-pulse size-3 shrink-0 rounded-full"
            style={{ backgroundColor: selectedTier?.color ?? 'hsl(var(--primary))' }}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              当前引擎
            </p>
            <p className="truncate text-[15px] font-semibold text-foreground">
              {selectedModel?.display_name ?? '等待选择'}
            </p>
          </div>
          {isFetching ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">同步中</span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          <p>{error}</p>
          {walletAction === 'recharge' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() =>
                void redirectToRecharge(router, { returnTo, triggerSource: 'model_switch' })
              }
            >
              去充值
            </Button>
          ) : null}
        </div>
      ) : null}

      {feedback ? (
        <p className="rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-[12px] text-primary">
          {feedback}
        </p>
      ) : null}

      <div className="space-y-3">
        {data.catalog.tiers.map((tier) => (
          <TierSection
            key={tier.key}
            tier={tier}
            collapsed={collapsed.has(tier.key)}
            selectedId={selectedId}
            onToggle={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(tier.key)) next.delete(tier.key);
                else next.add(tier.key);
                return next;
              })
            }
            onSelect={(modelId) => void handleSelect(modelId)}
          />
        ))}
      </div>
      <Dialog
        open={lockedTierKey !== null}
        onOpenChange={(open) => {
          if (!open) setLockedTierKey(null);
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-3xl">
          <DialogHeader>
            <DialogTitle>标准与旗舰模型需要 VIP</DialogTitle>
            <DialogDescription>
              开通后可以使用这两个档位。权益只解锁使用资格，不代表免费。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {pricedTiers.map((tier) => {
              const quote = formatTierQuote(tier);
              return (
                <p
                  key={tier.key}
                  className="rounded-2xl border border-border bg-card px-3 py-2 text-[12px] leading-relaxed"
                >
                  <span className="font-bold text-foreground">{tier.label}</span>
                  <span className="mt-1 block text-muted-foreground">
                    {quote?.summary ?? tier.cost_hint}
                  </span>
                </p>
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" className="w-full" onClick={() => router.push('/vip')}>
              前往 VIP
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TierSection({
  tier,
  collapsed,
  selectedId,
  onToggle,
  onSelect,
}: {
  tier: PublicModelCatalogTier;
  collapsed: boolean;
  selectedId: string;
  onToggle: () => void;
  onSelect: (modelId: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-4 py-3">
        {/* 档位说明整段换行，不截断：这行写的是每轮消耗多少星尘，截掉后半句等于没说 */}
        <span className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            className="mt-0.5 shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#090b12]"
            style={{ backgroundColor: tier.color }}
          >
            {tier.label}
          </span>
          <span className="min-w-0 flex-1 text-left text-[11px] font-medium leading-snug text-primary/90">
            {formatTierQuote(tier)?.summary ?? tier.cost_hint}
          </span>
          {tier.locked ? <Lock className="size-3.5 shrink-0 text-primary" aria-hidden /> : null}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
          aria-hidden
        />
      </button>

      {collapsed ? null : (
        <div className="divide-y divide-border border-t border-border">
          {tier.models.map((model) => {
            const active = model.id === selectedId;
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => onSelect(model.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
                  active ? 'bg-primary/10' : 'hover:bg-secondary'
                )}
              >
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border transition-transform',
                    active ? 'scale-110 border-transparent bg-primary' : 'border-border'
                  )}
                >
                  {active ? (
                    <Check className="size-3.5 text-primary-foreground" aria-hidden />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[15px] font-medium text-foreground">
                      {model.display_name}
                    </span>
                    {tier.locked ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                        <Lock className="size-3" aria-hidden />
                        VIP
                      </span>
                    ) : null}
                    {model.is_free ? (
                      <span className="shrink-0 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success">
                        限量免费
                      </span>
                    ) : null}
                  </span>
                  {model.tagline ? (
                    <span className="mt-1 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">
                      {model.tagline}
                    </span>
                  ) : null}
                </span>
                {active ? <Sparkles className="size-4 shrink-0 text-primary" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
