'use client';

/**
 * 编辑一项（或加一项）的弹层：名称 → 类型 → 样式（缩略图）→ 设置 → 开局值 → 说明。
 * 说明必填；"填空模板"按样式插入一句带 ___ 的模板，玩家只填空。创作者另有"AI 帮我写"。
 * 点"完成"走 shared 的同一套语义校验，不合格就地提示。
 */
import { useRef, useState } from 'react';
import {
  STATUS_BAR_LIMITS,
  STATUS_BAR_SPEC,
  STATUS_BAR_TYPE_DEFAULT,
  STATUS_FILL_BLANK,
  type StatusBarItem,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import {
  DescField,
  ErrorList,
  FormActions,
  InitField,
  ItemPreview,
  Label,
  NameField,
  StylePicker,
  StyleSettings,
  TypePicker,
  defaultsFor,
} from './status-item-fields';
import { issuesForItem, newStatusId, removeItem, replaceItem } from './status-template';

export interface StatusItemTarget {
  sectionId: string;
  item: StatusBarItem | null;
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
        <SheetDescription
          className={mode === 'player' ? 'sr-only' : 'mt-0.5 text-[12px] text-muted-foreground'}
        >
          名称、类型、说明三样填好就行
        </SheetDescription>
      </div>
      <NameField name={draft.name} onChange={(name) => set({ name })} />
      <TypePicker
        draft={draft}
        onPick={(type) =>
          setDraft((d) => ({ ...defaultsFor(STATUS_BAR_TYPE_DEFAULT[type], d), init: undefined }))
        }
      />
      <div>
        <Label>{mode === 'player' ? '样式' : '样式（点缩略图换）'}</Label>
        <StylePicker
          draft={draft}
          onPick={(style) => setDraft((d) => ({ ...defaultsFor(style, d), init: undefined }))}
        />
      </div>
      <StyleSettings key={draft.style} draft={draft} set={set} />
      <InitField draft={draft} mode={mode} onChange={(init) => set({ init })} />
      <DescField
        draft={draft}
        mode={mode}
        descRef={descRef}
        onChange={(desc) => set({ desc })}
        onFill={insertFill}
        ai={describe ? { busy: aiBusy, run: () => void askAi() } : null}
      />
      <ItemPreview item={draft} />
      <ErrorList errors={errors} />
      <FormActions
        onDelete={target.item ? () => onSave(removeItem(template, target.item!.id)) : null}
        onClose={onClose}
        onSave={save}
      />
    </div>
  );
}
