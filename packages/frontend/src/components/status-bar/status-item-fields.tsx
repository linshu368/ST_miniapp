'use client';

/** 编辑一项弹层里的各个字段（类型、样式缩略图、样式设置、开局值、说明、预览、按钮）。 */
import type { ReactNode, RefObject } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  STATUS_BAR_LIMITS,
  STATUS_BAR_SPEC,
  STATUS_BAR_STYLE_LABEL,
  STATUS_BAR_STYLE_TYPE,
  STATUS_BAR_TYPES,
  STATUS_BAR_TYPE_LABEL,
  STATUS_BAR_TYPE_STYLES,
  STATUS_NAME_FORBIDDEN,
  isListStyle,
  type StatusBarItem,
  type StatusBarStyle,
  type StatusBarType,
} from '@miniapp/shared';
import { cn } from '@/lib/utils';
import { StatusEntryPreview } from './status-view';
import { previewItemText } from './status-template';

export const FIELD =
  'block w-full min-w-0 rounded-xl border border-input bg-card px-3 py-2.5 text-[14px] text-foreground outline-none placeholder:text-[12.5px] placeholder:text-muted-foreground focus:border-primary/60';
export const chars = (value: string) => [...value].length;

export function defaultsFor(style: StatusBarStyle, base: StatusBarItem): StatusBarItem {
  const next: StatusBarItem = { id: base.id, name: base.name, style, desc: base.desc };
  if (style === 'bar') next.max = base.max ?? 100;
  if (style === 'stars') next.total = base.total ?? 5;
  if (style === 'number' && base.unit) next.unit = base.unit;
  if (style === 'stage') next.stages = base.stages ?? [];
  return next;
}

export function Label({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
      <span>{children}</span>
      {aside}
    </div>
  );
}

export function StylePicker({
  draft,
  onPick,
}: {
  draft: StatusBarItem;
  onPick: (style: StatusBarStyle) => void;
}) {
  const type = STATUS_BAR_STYLE_TYPE[draft.style];
  return (
    <div className="grid grid-cols-2 gap-2">
      {STATUS_BAR_TYPE_STYLES[type].map((style, index) => (
        <button
          key={style}
          type="button"
          aria-pressed={draft.style === style}
          onClick={() => onPick(style)}
          className={cn(
            'grid min-w-0 gap-1.5 rounded-xl bg-secondary dark:bg-white/[0.04] p-2.5 text-left ring-1 ring-inset',
            draft.style === style ? 'ring-primary' : 'ring-border'
          )}
        >
          <span className="flex items-center justify-between text-[12px] text-muted-foreground">
            {STATUS_BAR_STYLE_LABEL[style]}
            {index === 0 ? <span className="text-[10.5px] text-mauve">默认</span> : null}
          </span>
          <StatusEntryPreview
            text={previewItemText({ ...defaultsFor(style, draft), name: '示例', init: undefined })}
          />
        </button>
      ))}
    </div>
  );
}

export function StyleSettings({
  draft,
  set,
}: {
  draft: StatusBarItem;
  set: (patch: Partial<StatusBarItem>) => void;
}) {
  if (draft.style === 'bar')
    return (
      <NumberField
        label="上限"
        value={draft.max ?? 100}
        min={1}
        max={STATUS_BAR_LIMITS.barMax}
        onChange={(max) => set({ max })}
      />
    );
  if (draft.style === 'stars')
    return (
      <NumberField
        label="满星数"
        value={draft.total ?? 5}
        min={STATUS_BAR_LIMITS.starsMin}
        max={STATUS_BAR_LIMITS.starsMax}
        onChange={(total) => set({ total })}
      />
    );
  if (draft.style === 'number')
    return (
      <label className="block">
        <Label>单位（可空）</Label>
        <input
          className={FIELD}
          maxLength={STATUS_BAR_LIMITS.unitChars}
          value={draft.unit ?? ''}
          placeholder="比如：金币、次、天"
          onChange={(e) => set({ unit: e.target.value.replace(/[\d\s]/g, '') || undefined })}
        />
      </label>
    );
  if (draft.style === 'stage')
    return (
      <label className="block">
        <Label>阶段（从低到高，用顿号隔开，2–8 个）</Label>
        <input
          className={FIELD}
          defaultValue={(draft.stages ?? []).join('、')}
          placeholder="陌生、心动、暧昧、恋人"
          onChange={(e) =>
            set({
              stages: e.target.value
                .split(/[、,，\s]+/)
                .map((x) => x.trim())
                .filter(Boolean)
                .slice(0, STATUS_BAR_LIMITS.stagesMax),
            })
          }
        />
      </label>
    );
  return null;
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        className={FIELD}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        defaultValue={value}
        onChange={(e) =>
          onChange(Math.max(min, Math.min(max, Math.trunc(Number(e.target.value)) || min)))
        }
      />
    </label>
  );
}

export function TypePicker({
  draft,
  onPick,
}: {
  draft: StatusBarItem;
  onPick: (type: StatusBarType) => void;
}) {
  const current = STATUS_BAR_STYLE_TYPE[draft.style];
  return (
    <div>
      <Label>类型</Label>
      <div className="grid grid-cols-4 gap-1.5">
        {STATUS_BAR_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={current === type}
            onClick={() => current !== type && onPick(type)}
            className={cn(
              'min-h-10 rounded-xl text-[13px] ring-1 ring-inset',
              current === type
                ? 'bg-primary/10 text-primary ring-primary/40'
                : 'bg-card text-muted-foreground ring-border'
            )}
          >
            {STATUS_BAR_TYPE_LABEL[type]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function InitField({
  draft,
  mode,
  onChange,
}: {
  draft: StatusBarItem;
  mode: 'creator' | 'player';
  onChange: (init: string) => void;
}) {
  const hint = STATUS_BAR_SPEC[draft.style].initHint(draft);
  return (
    <label className="block">
      <Label>{mode === 'player' ? '从多少开始（选填）' : '开局时（选填）'}</Label>
      {isListStyle(draft.style) ? (
        <textarea
          className={cn(FIELD, 'min-h-[72px] resize-y')}
          value={draft.init ?? ''}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={FIELD}
          value={draft.init ?? ''}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

/**
 * 说明：必填；"插入填空模板"按样式给一句带 ___ 的模板；另有 AI 帮写：
 * 空着时按名称和样式写，已经写了几句就当方向，在它基础上写完整（原意不改）。
 */
export function DescField({
  draft,
  descRef,
  onChange,
  onFill,
  ai,
}: {
  draft: StatusBarItem;
  descRef: RefObject<HTMLTextAreaElement>;
  onChange: (desc: string) => void;
  onFill: () => void;
  ai: { busy: boolean; run: () => void } | null;
}) {
  return (
    <label className="block">
      <Label
        aside={
          <span className="tabular-nums">
            {chars(draft.desc.trim()) < STATUS_BAR_LIMITS.descMinChars
              ? `至少 ${STATUS_BAR_LIMITS.descMinChars} 字 · `
              : ''}
            {chars(draft.desc)}/{STATUS_BAR_LIMITS.descMaxChars}
          </span>
        }
      >
        说明（必填 · 写给 AI 看，决定它写什么、怎么变）
      </Label>
      <textarea
        ref={descRef}
        className={cn(FIELD, 'min-h-[96px] resize-y leading-6')}
        value={draft.desc}
        maxLength={STATUS_BAR_LIMITS.descMaxChars}
        placeholder={STATUS_BAR_SPEC[draft.style].descHint}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        <button type="button" onClick={onFill} className="min-h-9 text-[12.5px] text-primary">
          插入填空模板
        </button>
        {ai ? (
          <button
            type="button"
            onClick={ai.run}
            disabled={ai.busy}
            className="flex min-h-9 items-center gap-1 text-[12.5px] text-primary disabled:opacity-50"
          >
            {ai.busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {draft.desc.trim() ? 'AI 按我写的补完整' : 'AI 帮我写'}
          </button>
        ) : null}
      </span>
    </label>
  );
}

export function FormActions({
  onDelete,
  onClose,
  onSave,
}: {
  onDelete: (() => void) | null;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {onDelete ? (
        <button type="button" className="min-h-11 text-[13px] text-destructive" onClick={onDelete}>
          删除这一项
        </button>
      ) : (
        <button
          type="button"
          className="min-h-11 text-[13px] text-muted-foreground"
          onClick={onClose}
        >
          取消
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        className="min-h-11 rounded-xl bg-primary px-6 text-[14px] font-semibold text-primary-foreground"
      >
        完成
      </button>
    </div>
  );
}

/** 玩家在状态面板里看到的这一项。 */
export function ItemPreview({ item }: { item: StatusBarItem }) {
  return (
    <div>
      <Label>玩家看到的这一项</Label>
      <div className="rounded-2xl bg-secondary dark:bg-white/[0.05] p-3 ring-1 ring-inset ring-border dark:ring-white/[0.06]">
        <StatusEntryPreview text={previewItemText(item)} />
      </div>
    </div>
  );
}

export function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul role="alert" className="grid gap-1 text-[12.5px] text-destructive">
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}

/** 名称：过滤掉会破坏「名称：内容」行格式的字符（冒号、方括号等）。 */
export function NameField({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  return (
    <label className="block">
      <Label
        aside={
          <span className="tabular-nums">
            {chars(name)}/{STATUS_BAR_LIMITS.nameChars}
          </span>
        }
      >
        名称
      </Label>
      <input
        className={FIELD}
        value={name}
        maxLength={STATUS_BAR_LIMITS.nameChars}
        placeholder="比如：好感度、情欲、衣着"
        onChange={(e) =>
          onChange(e.target.value.replace(new RegExp(STATUS_NAME_FORBIDDEN.source, 'g'), ''))
        }
      />
    </label>
  );
}
