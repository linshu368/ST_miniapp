'use client';

import { cn } from '@/lib/utils';
import { platformAction, useBridgeStatus, useSTMirror } from '@/lib/bridge';
import { useState } from 'react';
import { useModelTiersQuery } from '@/lib/api/models';
import type { ModelTierConfig } from '@miniapp/shared';
import { Check } from 'lucide-react';

export function ModelTierSwitcher() {
  const bridgeStatus = useBridgeStatus();
  const currentModel = useSTMirror((s) => s.currentModel);
  const [switching, setSwitching] = useState(false);
  const { data, isLoading } = useModelTiersQuery();

  const isDisabled = bridgeStatus !== 'ready' || switching || isLoading;

  const tiers = data?.tiers || [];
  const activeTier =
    tiers.find((t: ModelTierConfig) => t.modelName === currentModel) ??
    tiers.find((t: ModelTierConfig) => t.isDefault) ??
    tiers[0];

  async function handleSwitch(tier: ModelTierConfig) {
    if (isDisabled || tier.modelName === currentModel) return;
    setSwitching(true);
    try {
      await platformAction('changeModel', {
        provider: tier.provider,
        modelName: tier.modelName,
      });
    } catch (err) {
      console.error('[ModelTierSwitcher] changeModel failed:', err);
    } finally {
      setSwitching(false);
    }
  }

  if (isLoading || tiers.length === 0) {
    return (
      <div className="flex items-center gap-1 rounded-full bg-black/40 backdrop-blur-sm p-0.5 h-[28px] w-[120px] animate-pulse" />
    );
  }

  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {tiers.map((tier: ModelTierConfig) => {
        const isActive = activeTier && tier.tier === activeTier.tier;
        return (
          <button
            key={tier.tier}
            disabled={isDisabled}
            onClick={() => handleSwitch(tier)}
            className={cn(
              'relative w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-xs font-medium transition-all border',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              isActive
                ? 'bg-purple-500/20 text-purple-100 border-purple-500/30 shadow-[0_0_10px_rgba(168,85,247,0.1)]'
                : 'bg-black/20 text-white/70 border-white/5 hover:bg-white/10 hover:text-white'
            )}
          >
            <span className="truncate pr-2">{tier.label}</span>
            {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-purple-400" />}
          </button>
        );
      })}
    </div>
  );
}
