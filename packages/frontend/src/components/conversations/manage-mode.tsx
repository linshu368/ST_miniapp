'use client';

import { FolderInput, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ConversationQuickFilter } from '@miniapp/shared';

import { cn } from '@/lib/utils';

const QUICK_LABELS: Record<ConversationQuickFilter, string> = {
  short: '只聊了一两句',
  idle: '30 天没聊',
};

/**
 * 管理是独立模式：顶部只剩「已选 N 个 · 全选 · 完成」和快捷筛选，进出都很明确，
 * 不和平时浏览的工具混在一起。
 */
export function ManageHeader({
  selectedCount,
  allSelected,
  hasRows,
  quick,
  targetName,
  onToggleAll,
  onQuick,
  onDone,
}: {
  selectedCount: number;
  allSelected: boolean;
  hasRows: boolean;
  quick?: ConversationQuickFilter;
  /** 从空分组进入「挑选对话放进来」时的分组名 */
  targetName?: string;
  onToggleAll: () => void;
  onQuick: (quick: ConversationQuickFilter | undefined) => void;
  onDone: () => void;
}) {
  return (
    <div className="px-4 pb-3">
      <div className="flex min-h-11 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold" aria-live="polite">
          {targetName ? `挑选对话放进「${targetName}」` : `已选 ${selectedCount} 个`}
        </h2>
        <button
          type="button"
          disabled={!hasRows}
          onClick={onToggleAll}
          className="min-h-10 rounded-2xl bg-secondary px-3 text-[13px] disabled:opacity-50"
        >
          {allSelected ? '取消全选' : '全选'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="min-h-10 rounded-2xl bg-secondary px-3 text-[13px] font-semibold text-primary"
        >
          完成
        </button>
      </div>
      {targetName ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">快速筛选</span>
          {(Object.keys(QUICK_LABELS) as ConversationQuickFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={quick === key}
              onClick={() => onQuick(quick === key ? undefined : key)}
              className={cn(
                'min-h-9 rounded-full px-3.5 text-[13px]',
                quick === key
                  ? 'bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/40'
                  : 'bg-secondary text-muted-foreground'
              )}
            >
              {QUICK_LABELS[key]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ACTION =
  'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl bg-secondary text-[12px] transition active:scale-[0.97] disabled:opacity-40';

/** 盖住底栏的操作条：管理模式下底栏导航本来就用不上。 */
export function ManageBar({
  selectedCount,
  allPinned,
  pending,
  targetName,
  onMove,
  onPin,
  onDelete,
  onPutInTarget,
}: {
  selectedCount: number;
  allPinned: boolean;
  pending: boolean;
  targetName?: string;
  onMove: () => void;
  onPin: () => void;
  onDelete: () => void;
  onPutInTarget: () => void;
}) {
  const disabled = selectedCount === 0 || pending;
  return (
    <div className="fixed inset-x-0 bottom-0 z-[45] flex justify-center bg-background px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
      <div
        role="toolbar"
        aria-label="批量操作"
        className="flex w-full max-w-2xl gap-1.5 rounded-[22px] border border-border bg-card p-2 shadow-2xl shadow-black/40"
      >
        {targetName ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onPutInTarget}
            className="min-h-12 flex-1 rounded-2xl bg-primary text-sm font-semibold text-primary-foreground transition active:scale-[0.98] disabled:opacity-40"
          >
            {pending
              ? '处理中…'
              : `放进「${targetName}」${selectedCount ? ` · ${selectedCount}` : ''}`}
          </button>
        ) : (
          <>
            <button type="button" disabled={disabled} onClick={onMove} className={ACTION}>
              <FolderInput className="size-[18px]" aria-hidden />
              移到分组
            </button>
            <button type="button" disabled={disabled} onClick={onPin} className={ACTION}>
              {allPinned ? (
                <PinOff className="size-[18px]" aria-hidden />
              ) : (
                <Pin className="size-[18px]" aria-hidden />
              )}
              {allPinned ? '取消置顶' : '置顶'}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onDelete}
              className={cn(ACTION, 'text-destructive')}
            >
              <Trash2 className="size-[18px]" aria-hidden />
              删除{selectedCount ? ` ${selectedCount}` : ''}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
