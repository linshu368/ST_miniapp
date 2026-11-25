'use client';
import type { ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isInstructionSlotEnabled } from './chat-generation-settings-state';
import { ChatDriveModePicker } from './chat-drive-mode-picker';
import type { ReplyDetailsDefaultOpen } from './reply-preference-display';
import {
  MAX_CUSTOM_INSTRUCTIONS,
  SLOT_CONFIG,
  useChatReplyPreferences,
} from './use-chat-reply-preferences';
interface ChatReplyPreferencesProps {
  maxContentHeight: number;
  detailsDefaultOpen: ReplyDetailsDefaultOpen;
  onDetailsDefaultOpenChange: (value: ReplyDetailsDefaultOpen) => void;
  thinkingControl?: ReactNode;
}

/** 输入框上方的轻量偏好抽屉；用户偏好仍只经 generation-config 写入。 */
export function ChatReplyPreferences({
  maxContentHeight,
  detailsDefaultOpen,
  onDetailsDefaultOpenChange,
  thinkingControl,
}: ChatReplyPreferencesProps) {
  const model = useChatReplyPreferences();
  const { open } = model;

  return (
    <section
      className={cn(
        'mb-1.5 flex min-h-[38px] shrink flex-col overflow-hidden rounded-2xl border transition-colors motion-reduce:transition-none',
        open ? 'border-border bg-card/95' : 'border-transparent bg-transparent'
      )}
      aria-label="回复偏好"
    >
      <PreferenceHeader model={model} thinkingControl={thinkingControl} />

      {open ? (
        <PreferenceContent
          model={model}
          maxContentHeight={maxContentHeight}
          detailsDefaultOpen={detailsDefaultOpen}
          onDetailsDefaultOpenChange={onDetailsDefaultOpenChange}
        />
      ) : null}
    </section>
  );
}

type ModelProps = { model: ReturnType<typeof useChatReplyPreferences> };

function PreferenceHeader({
  model,
  thinkingControl,
}: ModelProps & Pick<ChatReplyPreferencesProps, 'thinkingControl'>) {
  const { open, guideVisible, changeOpen, pointerStartY, suppressClick } = model;
  return (
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
        className="relative grid min-h-10 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2.5 pb-1 pt-2 text-left touch-pan-x"
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
  );
}

function PreferenceContent({
  model,
  maxContentHeight,
  detailsDefaultOpen,
  onDetailsDefaultOpenChange,
}: ModelProps & Omit<ChatReplyPreferencesProps, 'thinkingControl'>) {
  const {
    setScroller,
    driveModes,
    config,
    pendingDriveMode,
    driveModeFailed,
    changeDriveMode,
    instructions,
    setInstructionsDirty,
    setInstructions,
    saveInstructions,
    saving,
    saveFailed,
  } = model;
  return (
    <div
      ref={setScroller}
      className="chat-scroll-area min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 pt-1"
      style={{ maxHeight: Math.min(maxContentHeight, 384) }}
    >
      {driveModes && config ? (
        <div className="mb-3 border-b border-border/60">
          <ChatDriveModePicker
            driveModes={driveModes}
            activeId={config.pref_drive_mode}
            pendingId={pendingDriveMode}
            failed={driveModeFailed}
            onChange={changeDriveMode}
          />
        </div>
      ) : null}

      <PreferenceLength model={model} />

      <PreferenceSlots
        model={model}
        detailsDefaultOpen={detailsDefaultOpen}
        onDetailsDefaultOpenChange={onDetailsDefaultOpenChange}
      />

      <PreferenceStyles model={model} />

      <label className="mt-3 block border-t border-border/60 pt-3">
        <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-foreground">
          文风偏好
          <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-primary">
            所有角色
          </span>
        </span>
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
      ) : saving ? (
        <p className="mt-1.5 text-right text-[10px] text-muted-foreground">保存中…</p>
      ) : null}
    </div>
  );
}

function PreferenceLength({ model }: ModelProps) {
  const {
    query,
    config,
    wordCountTiers,
    lengthOptions,
    activeWordCount,
    pendingWordCount,
    changeWordCount,
  } = model;
  return (
    <section aria-label="回复长度" className="pb-3">
      <h3 className="mb-2 text-[11px] font-semibold text-foreground">回复长度</h3>
      {query.isPending && !config ? (
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
        <p className="py-2 text-[11px] text-muted-foreground">这里暂时没有可选的档位</p>
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
  );
}

function PreferenceSlots({
  model,
  detailsDefaultOpen,
  onDetailsDefaultOpenChange,
}: ModelProps &
  Pick<ChatReplyPreferencesProps, 'detailsDefaultOpen' | 'onDetailsDefaultOpenChange'>) {
  const { pendingSlotValues, config, toggleSlot } = model;
  return (
    <section className="border-t border-border/60 pt-3" aria-label="回复模块显示偏好">
      <h3 className="mb-2 text-[11px] font-semibold text-foreground">回复模块</h3>
      <div className="flex min-w-0 items-stretch gap-1">
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
    </section>
  );
}

function PreferenceStyles({ model }: ModelProps) {
  const {
    styleOptions,
    pendingStyleValues,
    config,
    failedStyleValues,
    styleDescriptionId,
    toggleReplyStyle,
  } = model;
  return styleOptions.length > 0 ? (
    <section className="mt-3 border-t border-border/60 pt-3" aria-label="回复风格">
      <h3 className="mb-2 text-[11px] font-semibold text-foreground">回复风格</h3>
      <div className="space-y-1.5">
        {styleOptions.map((option) => {
          const pending = Object.prototype.hasOwnProperty.call(pendingStyleValues, option.id);
          const enabled = pending
            ? pendingStyleValues[option.id] === true
            : config?.pref_reply_styles?.[option.id] === true;
          const failed = failedStyleValues[option.id] === true;
          const descriptionId = `${styleDescriptionId}-${option.id}`;
          return (
            <button
              key={option.id}
              type="button"
              role="switch"
              aria-label={option.name}
              aria-describedby={option.description || failed ? descriptionId : undefined}
              aria-checked={enabled}
              aria-busy={pending}
              disabled={!config || pending}
              onClick={() => toggleReplyStyle(option.id)}
              className={cn(
                'flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60',
                enabled
                  ? 'border-primary/35 bg-primary/10'
                  : 'border-border bg-secondary/35 hover:bg-secondary/60'
              )}
            >
              <span className="min-w-0 flex-1 break-words">
                <span className="block text-xs font-medium leading-[18px] text-foreground">
                  {option.name}
                </span>
                <span id={descriptionId}>
                  {option.description ? (
                    <span className="mt-1 block text-[11px] leading-[18px] text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                  {failed ? (
                    <span className="mt-1 block text-[10px] text-destructive" role="alert">
                      未保存，请重试
                    </span>
                  ) : null}
                </span>
              </span>
              <span
                aria-hidden
                className={cn(
                  'flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none',
                  enabled ? 'bg-primary' : 'bg-muted-foreground/30'
                )}
              >
                <span
                  className={cn(
                    'size-4 rounded-full bg-white shadow-sm dark:bg-foreground transition-transform motion-reduce:transition-none',
                    enabled && 'translate-x-4'
                  )}
                />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  ) : null;
}
