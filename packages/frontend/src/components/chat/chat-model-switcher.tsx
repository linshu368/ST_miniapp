'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import type { PublicModelCatalogTier } from '@miniapp/shared';

import { ApiClientError } from '@/lib/api/client';
import { useModelCatalogQuery, useSelectModelMutation } from '@/lib/api/models';
import { cn } from '@/lib/utils';

/**
 * 切换生成模型。
 *
 * 走 POST /api/v1/models/select 而不是 PATCH /api/v1/generation-config——
 * 后者只收三个 pref_* 字段，模型字段会被 400 掉；而且 select 那条路由带着
 * 「切到付费模型前先查余额」的闸门，绕过去就等于把闸门拆了。
 */
export function ChatModelSwitcher({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const { data, isLoading, refetch } = useModelCatalogQuery();
  const selectModel = useSelectModelMutation();
  const [error, setError] = useState<string | null>(null);

  const selectedId = data?.selected_model_id ?? '';

  const handleSelect = async (modelId: string) => {
    if (modelId === selectedId || selectModel.isPending) return;
    setError(null);
    try {
      await selectModel.mutateAsync({ model_id: modelId });
      await refetch();
    } catch (err) {
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
      <div className="space-y-2.5">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-16 animate-pulse rounded-2xl bg-card" />
        ))}
      </div>
    );
  }

  if (!data || data.catalog.tiers.length === 0) {
    return <p className="py-8 text-center text-[13px] text-muted-foreground">暂时没有可用模型</p>;
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      {data.catalog.tiers.map((tier) => (
        <TierSection
          key={tier.key}
          tier={tier}
          selectedId={selectedId}
          pending={selectModel.isPending}
          onSelect={(modelId) => void handleSelect(modelId)}
        />
      ))}
    </div>
  );
}

function TierSection({
  tier,
  selectedId,
  pending,
  onSelect,
}: {
  tier: PublicModelCatalogTier;
  selectedId: string;
  pending: boolean;
  onSelect: (modelId: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#090b12]"
          style={{ backgroundColor: tier.color }}
        >
          {tier.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-primary/90">
          {tier.cost_hint}
        </span>
      </div>

      <div className="divide-y divide-border border-t border-border">
        {tier.models.map((model) => {
          const active = model.id === selectedId;
          return (
            <button
              key={model.id}
              type="button"
              disabled={pending}
              onClick={() => onSelect(model.id)}
              className={cn(
                'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors disabled:opacity-55',
                active ? 'bg-primary/10' : 'hover:bg-secondary'
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-transparent bg-primary' : 'border-border'
                )}
              >
                {active ? <Check className="h-3.5 w-3.5 text-primary-foreground" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-foreground">
                  {model.display_name}
                </span>
                {model.tagline ? (
                  <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">
                    {model.tagline}
                  </span>
                ) : null}
              </span>
              {pending && active ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
