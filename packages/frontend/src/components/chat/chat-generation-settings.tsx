'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  useGenerationConfigQuery,
  usePatchGenerationConfigMutation,
} from '@/lib/api/generation-config';

const MAX_CUSTOM_INSTRUCTIONS = 500;

/**
 * 生成偏好。用户级配置，对所有会话生效——不是当前这段对话的设置，
 * 文案上要说清楚，否则用户会以为只改这一段。
 * 回复长度档位与按钮文案来自 runtime_config.pref_word_count_tiers。
 */
export function ChatGenerationSettings() {
  const query = useGenerationConfigQuery();
  const patch = usePatchGenerationConfigMutation();
  const config = query.data?.config;
  const wordCountTiers = query.data?.word_count_tiers;

  const [instructions, setInstructions] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);

  const lengthOptions = useMemo(() => {
    const tiers = wordCountTiers?.tiers ?? [];
    return tiers.slice().sort((a, b) => a.sort_order - b.sort_order);
  }, [wordCountTiers]);

  const columns = wordCountTiers?.layout.columns ?? 4;

  // 服务端值到手后灌进草稿，但不要盖掉用户正在编辑的内容
  useEffect(() => {
    if (instructionsDirty) return;
    setInstructions(config?.pref_custom_instructions ?? '');
  }, [config?.pref_custom_instructions, instructionsDirty]);

  if (query.isLoading || !config || !wordCountTiers) {
    return (
      <div className="flex justify-center py-10 text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
        加载中
      </div>
    );
  }

  const saveInstructions = () => {
    const next = instructions.trim();
    setInstructionsDirty(false);
    if (next === (config.pref_custom_instructions ?? '')) return;
    patch.mutate({ pref_custom_instructions: next.length > 0 ? next : null });
  };

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

      <section className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground">结尾给出选项</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            让角色在每次回复末尾提供几个可选的下一步
          </p>
        </div>
        <Switch
          checked={config.pref_show_options}
          disabled={patch.isPending}
          onCheckedChange={(checked) => patch.mutate({ pref_show_options: checked })}
          aria-label="结尾给出选项"
        />
      </section>

      <section>
        <h3 className="mb-1 text-[13px] font-semibold text-foreground">自定义指令</h3>
        <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
          对所有角色生效，例如「多写环境描写」「不要使用括号旁白」
        </p>
        <textarea
          value={instructions}
          onChange={(event) => {
            setInstructionsDirty(true);
            setInstructions(event.target.value);
          }}
          onBlur={saveInstructions}
          rows={3}
          maxLength={MAX_CUSTOM_INSTRUCTIONS}
          disabled={patch.isPending}
          placeholder="留空则不附加任何额外指令"
          aria-label="自定义指令"
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {instructionsDirty ? '离开输入框后自动保存' : patch.isPending ? '保存中…' : ''}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {instructions.length} / {MAX_CUSTOM_INSTRUCTIONS}
          </span>
        </div>
      </section>
    </div>
  );
}
