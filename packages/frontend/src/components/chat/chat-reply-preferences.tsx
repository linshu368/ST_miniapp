'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  useGenerationConfigQuery,
  usePatchGenerationConfigMutation,
} from '@/lib/api/generation-config';
import { cn } from '@/lib/utils';
import { isInstructionSlotEnabled } from './chat-generation-settings-state';
import type { ReplyDetailsDefaultOpen } from './reply-preference-display';

const MAX_CUSTOM_INSTRUCTIONS = 500;
const GUIDE_STORAGE_KEY = 'st.chat.reply-preferences-guide-seen.v1';
const GUIDE_VISIBLE_DURATION_MS = 5_000;
const GUIDE_FADE_DURATION_MS = 300;

type SlotKey = 'status' | 'memory' | 'choice';

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
  const enabledSlotLabels = SLOT_CONFIG.filter((slot) =>
    isInstructionSlotEnabled(config?.[slot.preference])
  ).map((slot) => slot.label);
  const [open, setOpen] = useState(false);
  const [guideVisible, setGuideVisible] = useState(false);
  const [guideFading, setGuideFading] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const pointerStartY = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const guideShown = useRef(false);
  const guideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (instructionsDirty) return;
    setInstructions(config?.pref_custom_instructions ?? '');
  }, [config?.pref_custom_instructions, instructionsDirty]);

  useEffect(
    () => () => {
      if (guideTimer.current !== null) window.clearTimeout(guideTimer.current);
    },
    []
  );

  const showFirstOpenGuide = () => {
    if (guideShown.current) return;
    guideShown.current = true;
    try {
      if (window.localStorage.getItem(GUIDE_STORAGE_KEY)) return;
      window.localStorage.setItem(GUIDE_STORAGE_KEY, '1');
    } catch {
      // 存储不可用时仍展示当前会话的一次提示。
    }
    setGuideFading(false);
    setGuideVisible(true);
    guideTimer.current = window.setTimeout(() => {
      setGuideFading(true);
      guideTimer.current = window.setTimeout(() => setGuideVisible(false), GUIDE_FADE_DURATION_MS);
    }, GUIDE_VISIBLE_DURATION_MS - GUIDE_FADE_DURATION_MS);
  };

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) showFirstOpenGuide();
  };

  const saveInstructions = () => {
    if (!config) return;
    const next = instructions.trim();
    setInstructionsDirty(false);
    if (next === (config.pref_custom_instructions ?? '')) return;
    patch.mutate({ pref_custom_instructions: next.length > 0 ? next : null });
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
        className="relative grid min-h-9 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-2.5 pb-1 pt-2 text-left touch-pan-x"
      >
        <span className="absolute left-1/2 top-0.5 h-0.5 w-8 -translate-x-1/2 rounded-full bg-muted-foreground/35" />
        <span className="min-w-0 text-[11px] font-semibold text-foreground">回复偏好</span>
        {guideVisible ? (
          <span
            className={cn(
              'pointer-events-none min-w-0 max-w-[calc(100vw-8.5rem)] justify-self-end truncate text-[10px] font-medium text-primary transition-opacity duration-300 motion-safe:animate-in motion-safe:fade-in-0',
              guideFading && 'opacity-0'
            )}
            aria-live="polite"
          >
            可以在这里开关 状态栏，记忆栏，选项等设置
          </span>
        ) : null}
        {!guideVisible ? (
          <span className="justify-self-end truncate text-[10px] text-muted-foreground">
            {enabledSlotLabels.join(' · ')}
          </span>
        ) : null}
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
              const enabled = config ? isInstructionSlotEnabled(config[slot.preference]) : false;
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
                    disabled={!config || patch.isPending}
                    onClick={() => patch.mutate({ [slot.preference]: !enabled })}
                    className={cn(
                      'flex min-w-0 flex-1 items-center justify-center gap-1 px-1.5 py-2 text-muted-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
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
              {instructionsDirty ? '离开输入框后自动保存' : patch.isPending ? '保存中…' : ''}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
