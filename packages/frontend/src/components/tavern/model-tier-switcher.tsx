'use client';

import { cn } from '@/lib/utils';
import { platformAction, useBridgeStatus, useSTMirror } from '@/lib/bridge';
import { useEffect, useRef, useState } from 'react';
import { useModelCatalogQuery, useSelectModelMutation } from '@/lib/api/models';
import type { PublicModelCatalogTier } from '@miniapp/shared';
import { Check, ChevronDown, ChevronLeft, Sparkles } from 'lucide-react';
import { useSTMirrorStore } from '@/stores/st-mirror';
import { useQueryClient } from '@tanstack/react-query';
import { optimisticBridgeAction } from '@/lib/bridge/optimistic-bridge-action';
import { ApiClientError } from '@/lib/api/client';
import { usePathname, useRouter } from 'next/navigation';

export function ModelTierSwitcher(props: { onBack: () => void; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const bridgeStatus = useBridgeStatus();
  const currentModel = useSTMirror((s) => s.currentModel);
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useModelCatalogQuery();
  const selectModel = useSelectModelMutation();
  const [selectedModelId, setSelectedModelId] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const lastAppliedRuntimeModel = useRef<string | null>(null);

  useEffect(() => {
    if (data?.selected_model_id) setSelectedModelId(data.selected_model_id);
  }, [data?.selected_model_id]);

  useEffect(() => {
    if (
      bridgeStatus !== 'ready' ||
      !data?.selected_openrouter_model_id ||
      currentModel === data.selected_openrouter_model_id ||
      lastAppliedRuntimeModel.current === data.selected_openrouter_model_id
    ) {
      return;
    }
    lastAppliedRuntimeModel.current = data.selected_openrouter_model_id;
    void platformAction('changeModel', {
      provider: 'openrouter',
      modelName: data.selected_openrouter_model_id,
    }).catch((error) => {
      lastAppliedRuntimeModel.current = null;
      console.error('[ModelTierSwitcher] initial model reconciliation failed:', error);
    });
  }, [bridgeStatus, currentModel, data?.selected_openrouter_model_id]);

  const allModels = data?.catalog.tiers.flatMap((tier) => tier.models) ?? [];
  const selectedModel =
    allModels.find((model) => model.id === selectedModelId) ??
    allModels.find((model) => model.id === data?.catalog.default_model_id);
  const selectedTier = data?.catalog.tiers.find((tier) =>
    tier.models.some((model) => model.id === selectedModel?.id)
  );
  const isDisabled = bridgeStatus !== 'ready' || selectModel.isPending || isLoading;

  async function handleSwitch(modelId: string) {
    if (isDisabled || modelId === selectedModelId) return;
    const previousId = selectedModelId;
    const previousRuntimeModel = currentModel;
    setFeedback(null);
    try {
      const result = await optimisticBridgeAction({
        applyOptimistic: () => setSelectedModelId(modelId),
        persist: () => selectModel.mutateAsync({ model_id: modelId }),
        bridge: async (persisted) => {
          useSTMirrorStore
            .getState()
            .updatePartial({ currentModel: persisted.openrouter_model_id });
          const applied = await platformAction('changeModel', {
            provider: 'openrouter',
            modelName: persisted.openrouter_model_id,
          });
          if (applied.appliedModel !== persisted.openrouter_model_id) {
            throw new Error(
              `模型运行时未完成切换：期望 ${persisted.openrouter_model_id}，实际 ${applied.appliedModel}`
            );
          }
        },
        rollbackPersisted: () =>
          previousId
            ? selectModel.mutateAsync({ model_id: previousId })
            : Promise.resolve(undefined),
        rollbackOptimistic: () => {
          setSelectedModelId(previousId);
          useSTMirrorStore.getState().updatePartial({ currentModel: previousRuntimeModel });
        },
        onRollbackError: (rollbackError) => {
          console.error('[ModelTierSwitcher] selection rollback failed:', rollbackError);
        },
      });
      queryClient.setQueryData(['modelCatalog'], (current: typeof data) =>
        current
          ? {
              ...current,
              selected_model_id: result.model_id,
              selected_openrouter_model_id: result.openrouter_model_id,
            }
          : current
      );
      setFeedback('模型已切换');
      window.setTimeout(props.onClose, 250);
    } catch (err) {
      console.error('[ModelTierSwitcher] changeModel failed:', err);
      if (err instanceof ApiClientError && err.code === 'INSUFFICIENT_CREDITS') {
        props.onClose();
        const search = new URLSearchParams({
          reason: 'insufficient_credits',
          returnTo: pathname,
        });
        router.push(`/profile/recharge?${search.toString()}`);
        return;
      }
      setFeedback(err instanceof Error ? err.message : '该模型暂不可用');
      void refetch();
    }
  }

  if (isLoading && !data) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-8">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-20 animate-pulse rounded-2xl bg-white/5" />
        ))}
      </div>
    );
  }

  if (!data || data.catalog.tiers.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">暂时没有可用模型</p>;
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-8">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={props.onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
          aria-label="返回工具箱"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="text-center">
          <h2 className="text-[17px] font-semibold text-foreground">选择剧情引擎</h2>
          <p className="text-[11px] text-muted-foreground">价格单位：星尘 / 万 token</p>
        </div>
        <div className="w-9 text-right text-[10px] text-muted-foreground">
          {isFetching ? '同步中' : ''}
        </div>
      </div>

      <div className="model-current-shimmer relative overflow-hidden rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3.5">
        <div className="relative z-10 flex items-center gap-3">
          <span
            className="model-tier-pulse h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: selectedTier?.color ?? '#818cf8' }}
          />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              当前引擎
            </p>
            <p className="truncate text-[15px] font-semibold text-foreground">
              {selectedModel?.display_name ?? '等待选择'}
            </p>
          </div>
        </div>
      </div>

      {feedback ? (
        <div className="rounded-xl border border-purple-400/20 bg-purple-400/10 px-3 py-2 text-xs text-purple-100">
          {feedback}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        {data.catalog.tiers.map((tier) => (
          <TierGroup
            key={tier.key}
            tier={tier}
            collapsed={collapsed.has(tier.key)}
            selectedModelId={selectedModelId}
            disabled={isDisabled}
            onToggle={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(tier.key)) next.delete(tier.key);
                else next.add(tier.key);
                return next;
              })
            }
            onSelect={(modelId) => void handleSwitch(modelId)}
          />
        ))}
      </div>
    </div>
  );
}

function TierGroup(props: {
  tier: PublicModelCatalogTier;
  collapsed: boolean;
  selectedModelId: string;
  disabled: boolean;
  onToggle: () => void;
  onSelect: (modelId: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <button
        type="button"
        onClick={props.onToggle}
        className="flex w-full items-center justify-between px-4 py-3"
      >
        <div className="flex items-center gap-2.5">
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#090b12]"
            style={{ backgroundColor: props.tier.color }}
          >
            {props.tier.label}
          </span>
          <span className="text-[11px] text-muted-foreground">{props.tier.cost_hint}</span>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            props.collapsed && '-rotate-90'
          )}
        />
      </button>
      {!props.collapsed ? (
        <div className="divide-y divide-border border-t border-border">
          {props.tier.models.map((model) => {
            const active = model.id === props.selectedModelId;
            const isFree = isFreeCatalogModel(model);
            return (
              <button
                key={model.id}
                type="button"
                disabled={props.disabled}
                onClick={() => props.onSelect(model.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-all disabled:opacity-50',
                  active ? 'bg-purple-400/12' : 'hover:bg-white/5'
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-transform',
                    active ? 'scale-110 border-transparent bg-primary' : 'border-border'
                  )}
                >
                  {active ? <Check className="h-3.5 w-3.5 text-primary-foreground" /> : null}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[15px] font-medium text-foreground">
                      {model.display_name}
                    </span>
                    {isFree ? (
                      <span className="shrink-0 rounded-full border border-emerald-300/25 bg-emerald-300/12 px-2 py-0.5 text-[10px] font-bold text-emerald-200">
                        免费
                      </span>
                    ) : null}
                  </div>
                  {/* 介绍语固定在名称下方：长名称不再与介绍语横向挤压，长文案按两行截断。 */}
                  {model.tagline ? (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {model.tagline}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {isFree
                      ? '0 星尘'
                      : `输入 ${model.price_input.toFixed(1)}✦　输出 ${model.price_output.toFixed(1)}✦`}
                  </p>
                </div>
                {active ? <Sparkles className="h-4 w-4 shrink-0 text-purple-300" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function isFreeCatalogModel(model: PublicModelCatalogTier['models'][number]): boolean {
  return 'is_free' in model && model.is_free === true;
}
