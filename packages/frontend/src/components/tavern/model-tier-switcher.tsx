'use client';

import { cn } from '@/lib/utils';
import { platformAction, useBridgeStatus, useSTMirror } from '@/lib/bridge';
import { useState } from 'react';
import { useModelTiersQuery } from '@/lib/api/models';
import type { ModelTierConfig } from '@miniapp/shared';

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
    <div className="flex items-center gap-1 rounded-full bg-black/40 backdrop-blur-sm p-0.5">
      {tiers.map((tier: ModelTierConfig) => {
        const isActive = activeTier && tier.tier === activeTier.tier;
        return (
          <button
            key={tier.tier}
            disabled={isDisabled}
            onClick={() => handleSwitch(tier)}
            className={cn(
              'relative rounded-full px-3 py-1 text-xs font-medium transition-all',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              isActive ? 'bg-white/20 text-white shadow-sm' : 'text-white/60 hover:text-white/80'
            )}
          >
            {tier.label}
          </button>
        );
      })}
    </div>
  );
}
