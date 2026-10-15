'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

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
  detailsDefaultOpen: ReplyDetailsDefaultOpen;
  onDetailsDefaultOpenChange: (value: ReplyDetailsDefaultOpen) => void;
}

/** 输入框上方的轻量偏好抽屉；模型规则仍只经 generation-config 写入。 */
export function ChatReplyPreferences({
  detailsDefaultOpen,
  onDetailsDefaultOpenChange,
}: ChatReplyPreferencesProps) {
  const query = useGenerationConfigQuery();
  const patch = usePatchGenerationConfigMutation({
    shouldOptimisticallyUpdate: (request) => SLOT_CONFIG.some((slot) => slot.preference in request),
  });
  const config = query.data?.config;
  const [open, setOpen] = useState(false);
  const [guideVisible, setGuideVisible] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [pendingSlotValues, setPendingSlotValues] = useState<PendingSlotValues>({});
  const enabledSlotLabels = SLOT_CONFIG.filter((slot) =>
    isInstructionSlotEnabled(pendingSlotValues[slot.key] ?? config?.[slot.preference])
  ).map((slot) => slot.label);
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

  const saveInstructions = () => {
    if (!config) return;
    const next = instructions.trim();
    setInstructionsDirty(false);
    if (next === (config.pref_custom_instructions ?? '')) return;
    patch.mutate({ pref_custom_instructions: next.length > 0 ? next : null });
  };

  const toggleSlot = (slot: (typeof SLOT_CONFIG)[number]) => {
    if (!config || Object.prototype.hasOwnProperty.call(pendingSlotValues, slot.key)) return;

    const enabled =
      pendingSlotValues[slot.key] ?? isInstructionSlotEnabled(config[slot.preference]);
    const next = !enabled;
    setPendingSlotValues((current) => ({ ...current, [slot.key]: next }));

    patch.mutate(
      { [slot.preference]: next },
      {
        onSettled: () => {
          setPendingSlotValues((current) => {
            if (current[slot.key] !== next) return current;
            const { [slot.key]: _completed, ...remaining } = current;
            return remaining;
          });
        },
      }
    );
  };

  return (
    <section
      className={cn(
        'mb-1.5 overflow-hidden rounded-2xl border transition-colors motion-reduce:transition-none',
        open ? 'border-border bg-card/95' : 'border-transparent bg-transparent'
      )}
      aria-label="回复偏好"
    >
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
        className="relative grid min-h-9 w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-2.5 pb-1 pt-2 text-left touch-pan-x"
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
          点击这里进行偏好开关设置
        </span>
        <span className="justify-self-end whitespace-nowrap text-[10px] text-muted-foreground">
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

      {open ? (
        <div className="px-3 pb-3 pt-1">
          <p className="mb-2 text-[10px] text-muted-foreground">
            仅影响后续回复；本次回复仍可临时展开或收起。
          </p>
          <div className="flex min-w-0 items-stretch gap-1" aria-label="回复模块显示偏好">
            {SLOT_CONFIG.map((slot) => {
              const slotPending = Object.prototype.hasOwnProperty.call(pendingSlotValues, slot.key);
              const enabled = config
                ? (pendingSlotValues[slot.key] ?? isInstructionSlotEnabled(config[slot.preference]))
                : false;
              const defaultOpen = detailsDefaultOpen[slot.key];
              return (
                <div
                  key={slot.key}
                  className={cn(
                    'flex min-w-0 flex-1 overflow-hidden rounded-lg border text-[11px] transition-colors',
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
                    onClick={() =>
                      onDetailsDefaultOpenChange({
                        ...detailsDefaultOpen,
                        [slot.key]: !defaultOpen,
                      })
                    }
                    className="shrink-0 border-l border-border px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:opacity-35"
                  >
                    {defaultOpen ? '展开' : '收起'}
                  </button>
                </div>
              );
            })}
          </div>

          <label className="mt-3 block">
            <span className="mb-1.5 block text-[11px] font-semibold text-foreground">我的偏好</span>
            <textarea
              value={instructions}
              onChange={(event) => {
                setInstructionsDirty(true);
                setInstructions(event.target.value);
              }}
              onBlur={saveInstructions}
              maxLength={MAX_CUSTOM_INSTRUCTIONS}
              disabled={!config || patch.isPending}
              placeholder="例如：保持克制，少用修辞"
              rows={3}
              className="block min-h-[76px] w-full resize-none rounded-xl border border-transparent bg-secondary/60 px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none disabled:opacity-50"
            />
          </label>
          {patch.isError ? (
            <p className="mt-1.5 text-[10px] text-destructive" role="alert">
              保存失败，请重试
            </p>
          ) : (
            <p className="mt-1.5 text-right text-[10px] text-muted-foreground">
              {instructionsDirty ? '离开输入框后自动保存' : ''}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
