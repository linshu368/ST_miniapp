'use client';

import { cn } from '@/lib/utils';
import { platformAction, useBridgeStatus, useSTMirror } from '@/lib/bridge';
import { useState } from 'react';

const TIERS = [
  {
    tier: 'standard' as const,
    modelName: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    label: '快餐模型',
  },
  {
    tier: 'premium' as const,
    modelName: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    label: '基础模型',
  },
] as const;

export function ModelTierSwitcher() {
  const bridgeStatus = useBridgeStatus();
  const currentModel = useSTMirror((s) => s.currentModel);
  const [switching, setSwitching] = useState(false);

  const isDisabled = bridgeStatus !== 'ready' || switching;

  const activeTier = TIERS.find((t) => t.modelName === currentModel) ?? TIERS[0];

  async function handleSwitch(tier: (typeof TIERS)[number]) {
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

  return (
    <div className="flex items-center gap-1 rounded-full bg-black/40 backdrop-blur-sm p-0.5">
      {TIERS.map((tier) => {
        const isActive = tier.tier === activeTier.tier;
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
