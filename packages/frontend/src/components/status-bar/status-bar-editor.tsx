'use client';

/**
 * 状态栏编辑器（创作者建卡、玩家工具箱共用）：预览卡本身可点——点项目改项目、点分区标题改分区，
 * 分区末尾"加一项"，卡下"加分区"。预览就是玩家在聊天页右侧状态面板里看到的样子。
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  STATUS_BAR_LIMITS,
  checkStatusBarTemplate,
  countStatusBarItems,
  type StatusBarItem,
  type StatusBarSection,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { cn } from '@/lib/utils';
import { StatusItemSheet, type StatusItemTarget } from './status-item-sheet';
import { StatusSectionSheet } from './status-section-sheet';
import { StatusEntryPreview } from './status-view';

const TAP =
  'block w-full rounded-lg px-1 py-0.5 -mx-1 text-left ring-1 ring-inset ring-transparent transition-colors hover:bg-border/70 dark:hover:bg-white/[0.03] hover:ring-primary/30 focus-visible:ring-primary disabled:pointer-events-none';
const ADD =
  'flex min-h-9 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border dark:border-white/15 text-[12.5px] text-muted-foreground hover:border-primary/40 hover:text-primary dark:hover:border-primary/40 disabled:opacity-40';

function SectionTitle({
  section,
  onEdit,
  disabled,
}: {
  section: StatusBarSection;
  onEdit: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={TAP}
      onClick={onEdit}
      disabled={disabled}
      aria-label={`编辑分区 ${section.title || '无标题'}`}
    >
      <span className="text-[12px] font-semibold tracking-wide text-mauve">
        {section.title || <span className="font-normal text-muted-foreground">无标题分区</span>}
      </span>
      {section.repeat ? (
        <span className="ml-1.5 text-[11.5px] text-muted-foreground">
          每个{section.repeat.what}一组
        </span>
      ) : null}
    </button>
  );
}

export function StatusBarEditor({
  template,
  onChange,
  mode,
  describe,
  disabled,
}: {
  template: StatusBarTemplate;
  onChange: (next: StatusBarTemplate) => void;
  mode: 'creator' | 'player';
  /** "AI 帮我写"说明（已写的当方向）；不传就不显示。 */
  describe?: (item: StatusBarItem) => Promise<string>;
  disabled?: boolean;
}) {
  const [itemTarget, setItemTarget] = useState<StatusItemTarget | null>(null);
  const [sectionTarget, setSectionTarget] = useState<{ section: StatusBarSection | null } | null>(
    null
  );
  const total = countStatusBarItems(template);
  const full = total >= STATUS_BAR_LIMITS.items;
  const missing = checkStatusBarTemplate(template).filter((issue) =>
    issue.code.startsWith('DESC_')
  );
  const save = (next: StatusBarTemplate) => {
    onChange(next);
    setItemTarget(null);
    setSectionTarget(null);
  };
  return (
    <div className="grid gap-2">
      <div className="grid gap-2.5 rounded-[22px] bg-gradient-to-br from-secondary to-secondary/50 p-3 dark:from-white/[0.07] dark:to-white/[0.025] dark:shadow-[inset_1px_1px_0_rgb(255_255_255/0.08)]">
        {template.sections.map((section) => (
          <section
            key={section.id}
            className="grid min-w-0 gap-2 rounded-2xl bg-secondary dark:bg-white/[0.05] p-3 ring-1 ring-inset ring-border dark:ring-white/[0.06]"
          >
            <SectionTitle
              section={section}
              disabled={disabled}
              onEdit={() => setSectionTarget({ section })}
            />
            {section.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={TAP}
                disabled={disabled}
                onClick={() => setItemTarget({ sectionId: section.id, item })}
                aria-label={`编辑 ${item.name}`}
              >
                <StatusEntryPreview item={item} />
              </button>
            ))}
            <button
              type="button"
              className={ADD}
              disabled={disabled || full}
              onClick={() => setItemTarget({ sectionId: section.id, item: null })}
            >
              <Plus className="size-3.5" aria-hidden />
              {full ? `最多 ${STATUS_BAR_LIMITS.items} 项` : '加一项'}
            </button>
          </section>
        ))}
        {template.sections.length < STATUS_BAR_LIMITS.sections ? (
          <button
            type="button"
            className={ADD}
            disabled={disabled}
            onClick={() => setSectionTarget({ section: null })}
          >
            <Plus className="size-3.5" aria-hidden />
            {mode === 'player' ? '加分区' : '加分区（比如【今晚】【回忆】）'}
          </button>
        ) : null}
      </div>
      <p className="flex flex-wrap justify-between gap-x-3 text-[11.5px] text-muted-foreground">
        {mode === 'creator' ? <span>点任意一项就能改</span> : null}
        <span className="ml-auto tabular-nums">
          {mode === 'creator' ? '已用 ' : null}
          {total} / {STATUS_BAR_LIMITS.items} 项
        </span>
      </p>
      {missing.length ? (
        <p role="status" className={cn('text-[12px] text-warn')}>
          {mode === 'player'
            ? `${missing.length} 项还没写说明`
            : `有 ${missing.length} 项的说明还没写好，AI 不知道这些项该写什么：点开补上`}
        </p>
      ) : null}
      <StatusItemSheet
        template={template}
        target={itemTarget}
        mode={mode}
        describe={describe}
        onClose={() => setItemTarget(null)}
        onSave={save}
      />
      <StatusSectionSheet
        template={template}
        target={sectionTarget}
        onClose={() => setSectionTarget(null)}
        onSave={save}
      />
    </div>
  );
}
