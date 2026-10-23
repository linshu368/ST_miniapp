'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import type { PatchGenerationConfigRequest } from '@miniapp/shared';

import {
  useGenerationConfigQuery,
  usePatchGenerationConfigMutation,
} from '@/lib/api/generation-config';
import { cn } from '@/lib/utils';
import { isInstructionSlotEnabled } from './chat-generation-settings-state';
import {
  claimReplyPreferenceGuide,
  type ReplyDetailsDefaultOpen,
} from './reply-preference-display';

const MAX_CUSTOM_INSTRUCTIONS = 500;

type SlotKey = 'status' | 'memory' | 'choice';
type PendingSlotValues = Partial<Record<SlotKey, boolean>>;

const SLOT_CONFIG: ReadonlyArray<{
  key: SlotKey;
  label: string;
  preference: 'pref_show_status' | 'pref_show_memory' | 'pref_show_options';
}> = [
  { key: 'status', label: '状态栏', preference: 'pref_show_status' },
  { key: 'memory', label: '记忆栏', preference: 'pref_show_memory' },
  { key: 'choice', label: '可选项', preference: 'pref_show_options' },
];

interface ChatReplyPreferencesProps {
  maxContentHeight: number;
  detailsDefaultOpen: ReplyDetailsDefaultOpen;
  onDetailsDefaultOpenChange: (value: ReplyDetailsDefaultOpen) => void;
  thinkingControl?: ReactNode;
}

/** 输入框上方的轻量偏好抽屉；模型规则仍只经 generation-config 写入。 */
export function ChatReplyPreferences({
  maxContentHeight,
  detailsDefaultOpen,
  onDetailsDefaultOpenChange,
  thinkingControl,
}: ChatReplyPreferencesProps) {
  const query = useGenerationConfigQuery();
  const patch = usePatchGenerationConfigMutation({
    shouldOptimisticallyUpdate: () => true,
  });
  const config = query.data?.config;
  const wordCountTiers = query.data?.word_count_tiers;
  const lengthOptions = (wordCountTiers?.tiers ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const [open, setOpen] = useState(false);
  const [guideVisible, setGuideVisible] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [pendingWordCount, setPendingWordCount] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pendingSlotValues, setPendingSlotValues] = useState<PendingSlotValues>({});
  const enabledSlotLabels = SLOT_CONFIG.filter((slot) =>
    isInstructionSlotEnabled(pendingSlotValues[slot.key] ?? config?.[slot.preference])
  ).map((slot) => slot.label);
  const activeWordCount =
    pendingWordCount ??
    (lengthOptions.some((tier) => tier.id === config?.pref_word_count)
      ? config?.pref_word_count
      : wordCountTiers?.default_tier_id);
  const saving =
    patch.isPending || pendingWordCount !== null || Object.keys(pendingSlotValues).length > 0;
  const pointerStartY = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const guideClaimed = useRef(false);

  useEffect(() => {
    if (guideClaimed.current) return;
    guideClaimed.current = true;
    setGuideVisible(claimReplyPreferenceGuide());
  }, []);

  useEffect(() => {
    if (instructionsDirty) return;
    setInstructions(config?.pref_custom_instructions ?? '');
  }, [config?.pref_custom_instructions, instructionsDirty]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) setGuideVisible(false);
  };

  const savePreference = async (request: PatchGenerationConfigRequest) => {
    setSaveFailed(false);
    try {
      await patch.mutateAsync(request);
    } catch {
      setSaveFailed(true);
    }
  };

  const changeWordCount = (id: string) => {
    if (!config || pendingWordCount !== null || id === activeWordCount) return;
    setPendingWordCount(id);
    void savePreference({ pref_word_count: id }).finally(() => setPendingWordCount(null));
  };

  const saveInstructions = () => {
    if (!config) return;
    const next = instructions.trim();
    setInstructionsDirty(false);
    if (next === (config.pref_custom_instructions ?? '')) return;
    void savePreference({ pref_custom_instructions: next.length > 0 ? next : null });
  };

  const toggleSlot = (slot: (typeof SLOT_CONFIG)[number]) => {
    if (!config || Object.prototype.hasOwnProperty.call(pendingSlotValues, slot.key)) return;

    const enabled =
      pendingSlotValues[slot.key] ?? isInstructionSlotEnabled(config[slot.preference]);
    const next = !enabled;
    setPendingSlotValues((current) => ({ ...current, [slot.key]: next }));

    // 每次请求独立清理，避免连续修改不同偏好时后一次调用替换前一次回调。
    void savePreference({ [slot.preference]: next }).finally(() => {
      setPendingSlotValues((current) => {
        if (current[slot.key] !== next) return current;
        const { [slot.key]: _completed, ...remaining } = current;
        return remaining;
      });
    });
  };

  return (
    <section
      className={cn(
        'mb-1.5 flex min-h-[38px] shrink flex-col overflow-hidden rounded-2xl border transition-colors motion-reduce:transition-none',
        open ? 'border-border bg-card/95' : 'border-transparent bg-transparent'
      )}
      aria-label="回复偏好"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            changeOpen(!open);
          }}
          onPointerDown={(event) => {
            pointerStartY.current = event.clientY;
          }}
          onPointerUp={(event) => {
            const start = pointerStartY.current;
            pointerStartY.current = null;
            if (start === null) return;
            const distance = event.clientY - start;
            if (distance <= -20) {
              suppressClick.current = true;
              changeOpen(true);
            }
            if (distance >= 20) {
              suppressClick.current = true;
              changeOpen(false);
            }
          }}
          onPointerCancel={() => {
            pointerStartY.current = null;
          }}
          className="relative grid min-h-10 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 px-2.5 pb-1 pt-2 text-left touch-pan-x"
        >
          <span className="absolute left-1/2 top-0.5 h-0.5 w-8 -translate-x-1/2 rounded-full bg-muted-foreground/35" />
          <span className="text-[11px] font-semibold text-foreground">回复偏好</span>
          <span
            className={cn(
              'pointer-events-none min-w-0 truncate text-[10px] font-medium text-primary',
              !guideVisible && 'invisible'
            )}
            aria-hidden={!guideVisible}
          >
            调整回复长度与内容
          </span>
          <span className="hidden justify-self-end whitespace-nowrap text-[10px] text-muted-foreground min-[430px]:inline">
            {enabledSlotLabels.join(' · ')}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180'
            )}
            aria-hidden
          />
        </button>
        {thinkingControl}
      </div>

      {open ? (
        <div
          className="chat-scroll-area min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 pt-1"
          style={{ maxHeight: Math.min(maxContentHeight, 384) }}
        >
          <section aria-label="回复长度" className="pb-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold text-foreground">回复长度</h3>
              <span className="text-[10px] text-muted-foreground">应用于后续回复</span>
            </div>
            {query.isLoading && !config ? (
              <p
                className="flex min-h-9 items-center gap-1.5 text-[11px] text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                加载偏好中
              </p>
            ) : !config || !wordCountTiers ? (
              <div className="flex min-h-9 items-center justify-between gap-2 text-[11px]">
                <p className="text-muted-foreground" role="alert">
                  偏好加载失败
                </p>
                <button
                  type="button"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                  className="rounded-lg px-2 py-1 text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  {query.isFetching ? '重试中…' : '重试'}
                </button>
              </div>
            ) : lengthOptions.length === 0 ? (
              <p className="py-2 text-[11px] text-muted-foreground">暂无可用档位</p>
            ) : (
              <div
                className="grid gap-1.5"
                style={{
                  gridTemplateColumns: `repeat(${wordCountTiers.layout.columns}, minmax(0, 1fr))`,
                }}
              >
                {lengthOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={option.id === activeWordCount}
                    aria-busy={option.id === pendingWordCount}
                    disabled={pendingWordCount !== null}
                    onClick={() => changeWordCount(option.id)}
                    className={cn(
                      'min-h-9 min-w-0 break-words rounded-lg border px-1.5 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait',
                      option.id === activeWordCount
                        ? 'border-primary/35 bg-primary/10 text-primary'
                        : 'border-border bg-secondary/35 text-muted-foreground hover:bg-secondary'
                    )}
                  >
                    {option.ui_label}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="border-t border-border/60 pt-3" aria-label="回复模块显示偏好">
            <h3 className="mb-2 text-[11px] font-semibold text-foreground">回复模块</h3>
            <div className="flex min-w-0 items-stretch gap-1">
              {SLOT_CONFIG.map((slot) => {
                const slotPending = Object.prototype.hasOwnProperty.call(
                  pendingSlotValues,
                  slot.key
                );
                const enabled = config
                  ? (pendingSlotValues[slot.key] ??
                    isInstructionSlotEnabled(config[slot.preference]))
                  : false;
                const defaultOpen = detailsDefaultOpen[slot.key];
                return (
                  <div
                    key={slot.key}
                    className={cn(
                      'flex min-w-0 flex-1 overflow-hidden rounded-lg border text-[11px] transition-colors max-[359px]:flex-col',
                      enabled ? 'border-primary/35 bg-primary/10' : 'border-border bg-secondary/35'
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={enabled}
                      aria-busy={slotPending}
                      disabled={!config || slotPending}
                      onClick={() => toggleSlot(slot)}
                      className={cn(
                        'flex min-w-0 flex-1 items-center justify-center gap-1 px-1.5 py-2 text-muted-foreground transition-colors hover:bg-secondary disabled:cursor-wait',
                        enabled && 'text-primary'
                      )}
                    >
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full bg-muted-foreground/50',
                          enabled && 'bg-primary'
                        )}
                        aria-hidden
                      />
                      <span className="truncate">{slot.label}</span>
                    </button>
                    <button
                      type="button"
                      disabled={!enabled}
                      aria-pressed={defaultOpen}
                      aria-label={`${slot.label}默认${defaultOpen ? '展开' : '收起'}`}
                      onClick={() =>
                        onDetailsDefaultOpenChange({
                          ...detailsDefaultOpen,
                          [slot.key]: !defaultOpen,
                        })
                      }
                      className="shrink-0 border-l border-border px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:opacity-35 max-[359px]:border-l-0 max-[359px]:border-t max-[359px]:py-1"
                    >
                      {defaultOpen ? '展开' : '收起'}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
              当前回复仍可随时展开或收起
            </p>
          </section>

          <label className="mt-3 block border-t border-border/60 pt-3">
            <span className="mb-1.5 block text-[11px] font-semibold text-foreground">我的偏好</span>
            <textarea
              value={instructions}
              onChange={(event) => {
                setInstructionsDirty(true);
                setInstructions(event.target.value);
              }}
              onBlur={saveInstructions}
              maxLength={MAX_CUSTOM_INSTRUCTIONS}
              disabled={!config || saving}
              placeholder="例如：保持克制，少用修辞"
              rows={3}
              className="block min-h-[76px] w-full resize-none rounded-xl border border-transparent bg-secondary/60 px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none disabled:opacity-50"
            />
          </label>
          {saveFailed ? (
            <p className="mt-1.5 text-[10px] text-destructive" role="alert">
              保存失败，请重试
            </p>
          ) : (
            <p className="mt-1.5 text-right text-[10px] text-muted-foreground">
              {saving ? '保存中…' : instructionsDirty ? '离开输入框后自动保存' : '自动保存'}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
