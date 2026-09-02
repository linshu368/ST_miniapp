'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import type { PublicModelCatalogTier } from '@miniapp/shared';

import { ApiClientError } from '@/lib/api/client';
import { useModelCatalogQuery, useSelectModelMutation } from '@/lib/api/models';
import { cn } from '@/lib/utils';

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
}: {
  returnTo: string;
  /** 切换成功后通知外层收起工具箱，与原版一致 */
  onSwitched?: () => void;
}) {
  const router = useRouter();
  const { data, isLoading, isFetching } = useModelCatalogQuery();
  const selectModel = useSelectModelMutation();
  const [error, setError] = useState<string | null>(null);
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
    latestSelectRef.current = modelId;
    setError(null);
    setFeedback(null);
    try {
      await selectModel.mutateAsync({ model_id: modelId });
      if (latestSelectRef.current !== modelId) return;
      setFeedback('模型已切换');
      if (onSwitched) window.setTimeout(onSwitched, 250);
    } catch (err) {
      if (latestSelectRef.current !== modelId) return;
      // 余额闸门拦下来的话，能做的只有去充值，直接把人送过去
      if (err instanceof ApiClientError && err.code === 'INSUFFICIENT_CREDITS') {
        router.push(
          `/profile/recharge?${new URLSearchParams({
            reason: 'insufficient_credits',
            returnTo,
          }).toString()}`
        );
        return;
      }
      setError(err instanceof Error ? err.message : '该模型暂不可用');
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

  return (
    <div className="space-y-4">
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
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
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
            {tier.cost_hint}
          </span>
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
