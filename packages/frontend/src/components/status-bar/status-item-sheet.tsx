'use client';

/**
 * 编辑一项（或加一项）的弹层：名称 → 类型 → 样式（缩略图）→ 设置 → 开局值 → 说明。
 * 说明必填；"填空模板"按样式插入一句带 ___ 的模板，玩家只填空。创作者另有"AI 帮我写"。
 * 点"完成"走 shared 的同一套语义校验，不合格就地提示。
 */
import { useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  STATUS_BAR_LIMITS,
  STATUS_BAR_SPEC,
  STATUS_BAR_STYLE_LABEL,
  STATUS_BAR_STYLE_TYPE,
  STATUS_BAR_TYPES,
  STATUS_BAR_TYPE_DEFAULT,
  STATUS_BAR_TYPE_LABEL,
  STATUS_BAR_TYPE_STYLES,
  STATUS_FILL_BLANK,
  STATUS_NAME_FORBIDDEN,
  isListStyle,
  type StatusBarItem,
  type StatusBarStyle,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { StatusEntryPreview } from './status-view';
import {
  issuesForItem,
  newStatusId,
  previewItemText,
  removeItem,
  replaceItem,
} from './status-template';

export interface StatusItemTarget {
  sectionId: string;
  item: StatusBarItem | null;
}

const FIELD =
  'block w-full min-w-0 rounded-xl border border-input bg-card px-3 py-2.5 text-[14px] text-foreground outline-none placeholder:text-[12.5px] placeholder:text-muted-foreground focus:border-primary/60';
const chars = (value: string) => [...value].length;

function defaultsFor(style: StatusBarStyle, base: StatusBarItem): StatusBarItem {
  const next: StatusBarItem = { id: base.id, name: base.name, style, desc: base.desc };
  if (style === 'bar') next.max = base.max ?? 100;
  if (style === 'stars') next.total = base.total ?? 5;
  if (style === 'number' && base.unit) next.unit = base.unit;
  if (style === 'stage') next.stages = base.stages ?? [];
  return next;
}

function Label({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
      <span>{children}</span>
      {aside}
    </div>
  );
}

function StylePicker({
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
            'grid min-w-0 gap-1.5 rounded-xl bg-white/[0.04] p-2.5 text-left ring-1 ring-inset',
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

function StyleSettings({
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

export function StatusItemSheet({
  template,
  target,
  mode,
  onClose,
  onSave,
  describe,
}: {
  template: StatusBarTemplate;
  target: StatusItemTarget | null;
  mode: 'creator' | 'player';
  onClose: () => void;
  onSave: (next: StatusBarTemplate) => void;
  describe?: (item: StatusBarItem) => Promise<string>;
}) {
  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="chat-scroll-area max-h-[90vh] overflow-y-auto rounded-t-3xl border-border bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-5"
      >
        {target ? (
          <ItemForm
            key={target.item?.id ?? 'new'}
            {...{ template, target, mode, onClose, onSave, describe }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ItemForm({
  template,
  target,
  mode,
  onClose,
  onSave,
  describe,
}: {
  template: StatusBarTemplate;
  target: StatusItemTarget;
  mode: 'creator' | 'player';
  onClose: () => void;
  onSave: (next: StatusBarTemplate) => void;
  describe?: (item: StatusBarItem) => Promise<string>;
}) {
  const [draft, setDraft] = useState<StatusBarItem>(
    () => target.item ?? { id: newStatusId('i'), name: '', style: 'bar', desc: '', max: 100 }
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<StatusBarItem>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors([]);
  };
  const spec = STATUS_BAR_SPEC[draft.style];
  const insertFill = () => {
    set({ desc: spec.fillTemplate });
    requestAnimationFrame(() => {
      const el = descRef.current;
      if (!el) return;
      el.focus();
      const at = el.value.indexOf(STATUS_FILL_BLANK);
      if (at >= 0) el.setSelectionRange(at, at + STATUS_FILL_BLANK.length);
    });
  };
  const askAi = async () => {
    if (!describe || !draft.name.trim()) return setErrors(['先起个名字，AI 才知道写什么']);
    setAiBusy(true);
    try {
      set({ desc: (await describe(draft)).slice(0, STATUS_BAR_LIMITS.descMaxChars) });
    } catch {
      setErrors(['AI 暂时没写好，再试一次或自己写']);
    } finally {
      setAiBusy(false);
    }
  };
  const save = () => {
    const clean: StatusBarItem = {
      ...draft,
      name: draft.name.trim(),
      desc: draft.desc.trim(),
      init: draft.init?.trim() || undefined,
    };
    if (!clean.name) return setErrors(['先起个名字']);
    const next = replaceItem(template, target.sectionId, clean, target.item === null);
    const issues = issuesForItem(next, clean.id);
    if (issues.length) return setErrors(issues.map((issue) => issue.message));
    onSave(next);
  };
  return (
    <div className="grid gap-4">
      <div>
        <SheetTitle className="text-[16px] font-bold">
          {target.item ? `编辑「${target.item.name}」` : '加一项'}
        </SheetTitle>
        <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
          名称、类型、说明三样填好就行
        </SheetDescription>
      </div>
      <label className="block">
        <Label
          aside={
            <span className="tabular-nums">
              {chars(draft.name)}/{STATUS_BAR_LIMITS.nameChars}
            </span>
          }
        >
          名称
        </Label>
        <input
          className={FIELD}
          value={draft.name}
          maxLength={STATUS_BAR_LIMITS.nameChars}
          placeholder="比如：好感度、情欲、衣着"
          onChange={(e) =>
            set({ name: e.target.value.replace(new RegExp(STATUS_NAME_FORBIDDEN.source, 'g'), '') })
          }
        />
      </label>
      <div>
        <Label>类型</Label>
        <div className="grid grid-cols-4 gap-1.5">
          {STATUS_BAR_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={STATUS_BAR_STYLE_TYPE[draft.style] === type}
              onClick={() =>
                STATUS_BAR_STYLE_TYPE[draft.style] !== type &&
                setDraft((d) => ({
                  ...defaultsFor(STATUS_BAR_TYPE_DEFAULT[type], d),
                  init: undefined,
                }))
              }
              className={cn(
                'min-h-10 rounded-xl text-[13px] ring-1 ring-inset',
                STATUS_BAR_STYLE_TYPE[draft.style] === type
                  ? 'bg-primary/10 text-primary ring-primary/40'
                  : 'bg-card text-muted-foreground ring-border'
              )}
            >
              {STATUS_BAR_TYPE_LABEL[type]}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>样式（点缩略图换）</Label>
        <StylePicker
          draft={draft}
          onPick={(style) => setDraft((d) => ({ ...defaultsFor(style, d), init: undefined }))}
        />
      </div>
      <StyleSettings key={draft.style} draft={draft} set={set} />
      <label className="block">
        <Label>{mode === 'player' ? '从多少开始（选填）' : '开局时（选填）'}</Label>
        {isListStyle(draft.style) ? (
          <textarea
            className={cn(FIELD, 'min-h-[72px] resize-y')}
            value={draft.init ?? ''}
            placeholder={spec.initHint(draft)}
            onChange={(e) => set({ init: e.target.value })}
          />
        ) : (
          <input
            className={FIELD}
            value={draft.init ?? ''}
            placeholder={spec.initHint(draft)}
            onChange={(e) => set({ init: e.target.value })}
          />
        )}
      </label>
      <label className="block">
        <Label
          aside={
            <span className="tabular-nums">
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
          placeholder={spec.descHint}
          onChange={(e) => set({ desc: e.target.value })}
        />
        <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" onClick={insertFill} className="min-h-9 text-[12.5px] text-primary">
            插入填空模板
          </button>
          {mode === 'creator' && describe ? (
            <button
              type="button"
              onClick={() => void askAi()}
              disabled={aiBusy}
              className="flex min-h-9 items-center gap-1 text-[12.5px] text-primary disabled:opacity-50"
            >
              {aiBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              AI 帮我写
            </button>
          ) : null}
        </span>
      </label>
      <div>
        <Label>玩家看到的这一项</Label>
        <div className="rounded-2xl bg-white/[0.05] p-3 ring-1 ring-inset ring-white/[0.06]">
          <StatusEntryPreview text={previewItemText(draft)} />
        </div>
      </div>
      {errors.length ? (
        <ul role="alert" className="grid gap-1 text-[12.5px] text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        {target.item ? (
          <button
            type="button"
            className="min-h-11 text-[13px] text-destructive"
            onClick={() => onSave(removeItem(template, target.item!.id))}
          >
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
          onClick={save}
          className="min-h-11 rounded-xl bg-primary px-6 text-[14px] font-semibold text-primary-foreground"
        >
          完成
        </button>
      </div>
    </div>
  );
}
