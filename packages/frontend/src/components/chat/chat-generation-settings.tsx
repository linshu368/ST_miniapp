'use client';

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  useGenerationConfigQuery,
  usePatchGenerationConfigMutation,
} from '@/lib/api/generation-config';

/**
 * 回复长度仍在工具箱内；规则槽位和自定义偏好已移至输入框上方的轻量抽屉。
 */
export function ChatGenerationSettings() {
  const query = useGenerationConfigQuery();
  const patch = usePatchGenerationConfigMutation();
  const config = query.data?.config;
  const wordCountTiers = query.data?.word_count_tiers;

  const lengthOptions = useMemo(() => {
    const tiers = wordCountTiers?.tiers ?? [];
    return tiers.slice().sort((a, b) => a.sort_order - b.sort_order);
  }, [wordCountTiers]);

  const columns = wordCountTiers?.layout.columns ?? 4;

  if (query.isLoading || !config || !wordCountTiers) {
    return (
      <div className="flex justify-center py-10 text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
        加载中
      </div>
    );
  }

  const activeWordCount = lengthOptions.some((tier) => tier.id === config.pref_word_count)
    ? config.pref_word_count
    : wordCountTiers.default_tier_id;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">回复长度</h3>
        {lengthOptions.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">暂无可用档位</p>
        ) : (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {lengthOptions.map((option) => {
              const active = option.id === activeWordCount;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ pref_word_count: option.id })}
                  className={cn(
                    'rounded-xl border py-2 text-[13px] font-medium transition-colors disabled:opacity-55',
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border bg-card text-muted-foreground hover:bg-secondary'
                  )}
                >
                  {option.ui_label}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
