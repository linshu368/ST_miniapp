'use client';

/** 分区设置：标题（可空、可带 emoji）、写几组（只写一组 / 每个___各一组）。 */
import { useState } from 'react';
import { STATUS_BAR_LIMITS, type StatusBarSection, type StatusBarTemplate } from '@miniapp/shared';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { newStatusId, removeSection, replaceSection } from './status-template';

const FIELD =
  'block w-full min-w-0 rounded-xl border border-input bg-card px-3 py-2.5 text-[14px] text-foreground outline-none placeholder:text-[12.5px] placeholder:text-muted-foreground focus:border-primary/60';

export function StatusSectionSheet({
  template,
  target,
  onClose,
  onSave,
}: {
  template: StatusBarTemplate;
  /** null 关闭；{ section: null } 新建 */
  target: { section: StatusBarSection | null } | null;
  onClose: () => void;
  onSave: (next: StatusBarTemplate) => void;
}) {
  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="rounded-t-3xl border-border bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-5"
      >
        {target ? (
          <SectionForm
            key={target.section?.id ?? 'new'}
            template={template}
            section={target.section}
            onClose={onClose}
            onSave={onSave}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type Repeat = StatusBarSection['repeat'];

/** 只写一组 / 每个___各一组（最多几组）。 */
function RepeatPicker({
  repeat,
  onChange,
}: {
  repeat: Repeat;
  onChange: (repeat: Repeat) => void;
}) {
  const clampMax = (raw: string) =>
    Math.max(1, Math.min(STATUS_BAR_LIMITS.repeatMax, Math.trunc(Number(raw)) || 1));
  return (
    <div>
      <span className="mb-1.5 block text-[12.5px] text-muted-foreground">写几组</span>
      <div className="grid grid-cols-2 gap-1.5">
        {(
          [
            ['只写一组', false],
            ['每个___各一组', true],
          ] as const
        ).map(([label, on]) => (
          <button
            key={label}
            type="button"
            aria-pressed={Boolean(repeat) === on}
            onClick={() => onChange(on ? (repeat ?? { what: '在场的她', max: 2 }) : null)}
            className={cn(
              'min-h-10 rounded-xl text-[13px] ring-1 ring-inset',
              Boolean(repeat) === on
                ? 'bg-primary/10 text-primary ring-primary/40'
                : 'bg-card text-muted-foreground ring-border'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {repeat ? (
        <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto_4.5em_auto] items-center gap-1.5 text-[13px] text-muted-foreground">
          每个
          <input
            className={FIELD}
            value={repeat.what}
            maxLength={STATUS_BAR_LIMITS.repeatWhatChars}
            onChange={(e) => onChange({ ...repeat, what: e.target.value })}
          />
          各一组，最多
          <input
            className={FIELD}
            type="number"
            min={1}
            max={STATUS_BAR_LIMITS.repeatMax}
            value={repeat.max}
            onChange={(e) => onChange({ ...repeat, max: clampMax(e.target.value) })}
          />
          组
        </div>
      ) : null}
    </div>
  );
}

function SectionForm({
  template,
  section,
  onClose,
  onSave,
}: {
  template: StatusBarTemplate;
  section: StatusBarSection | null;
  onClose: () => void;
  onSave: (next: StatusBarTemplate) => void;
}) {
  const [draft, setDraft] = useState<StatusBarSection>(
    () => section ?? { id: newStatusId('s'), title: '', repeat: null, items: [] }
  );
  const [error, setError] = useState('');
  const canDelete = section !== null && template.sections.length > 1;
  const save = () => {
    const title = draft.title.replace(/[【】[\]<>]/g, '').trim();
    if (draft.repeat && !title) return setError('每人一组的分区要写个占位名，比如"人物名"');
    if (draft.repeat && template.sections.some((s) => s.repeat && s.id !== draft.id))
      return setError('只能有一个"每个___各一组"的分区');
    if (!section && template.sections.length >= STATUS_BAR_LIMITS.sections)
      return setError(`最多 ${STATUS_BAR_LIMITS.sections} 个分区`);
    onSave(replaceSection(template, { ...draft, title }, section === null));
  };
  return (
    <div className="grid gap-4">
      <div>
        <SheetTitle className="text-[16px] font-bold">{section ? '分区设置' : '加分区'}</SheetTitle>
        <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
          比如【今晚】【回忆】；每个在场的她各一组也在这里设
        </SheetDescription>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] text-muted-foreground">
          分区标题（可空、可带 emoji）
        </span>
        <input
          className={FIELD}
          value={draft.title}
          maxLength={STATUS_BAR_LIMITS.sectionTitleChars}
          placeholder={draft.repeat ? '占位名，比如：人物名' : '比如：今晚、她、回忆'}
          onChange={(e) => {
            setDraft({ ...draft, title: e.target.value });
            setError('');
          }}
        />
      </label>
      <RepeatPicker repeat={draft.repeat} onChange={(repeat) => setDraft({ ...draft, repeat })} />
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        {canDelete ? (
          <button
            type="button"
            className="min-h-11 text-[13px] text-destructive"
            onClick={() => onSave(removeSection(template, section!.id))}
          >
            删除这个分区
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
