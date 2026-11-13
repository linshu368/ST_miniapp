'use client';

import { useRef } from 'react';
import { Ellipsis, Folder, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ChatFolder, ChatFolderSummary } from '@miniapp/shared';
import { CHAT_FOLDER_LIMIT } from '@miniapp/shared';

import type { FolderFilter } from '@/lib/api/conversation-folders';
import { cn } from '@/lib/utils';

const CHIP =
  'inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full px-3.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * 分组标签：全部 · 各分组 · 未分组 · ＋新建，像 Telegram 的聊天文件夹。
 * 只有当前选中的标签用香槟金，其余保持灰色，避免一排标签抢列表的注意力。
 */
export function FolderTabs({
  summary,
  active,
  onSelect,
  onCreate,
}: {
  summary: ChatFolderSummary;
  active: FolderFilter;
  onSelect: (folder: FolderFilter) => void;
  onCreate: () => void;
}) {
  const tab = (id: FolderFilter, label: string, count: number) => (
    <button
      key={id}
      type="button"
      aria-pressed={active === id}
      onClick={() => onSelect(id)}
      className={cn(
        CHIP,
        active === id
          ? 'bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/40'
          : 'bg-secondary text-muted-foreground'
      )}
    >
      <span className="max-w-[7rem] truncate">{label}</span>
      <span className="text-[11px] font-normal opacity-70">{count}</span>
    </button>
  );

  return (
    <nav
      aria-label="对话分组"
      className="flex gap-2 overflow-x-auto px-4 pb-3 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tab('all', '全部', summary.all)}
      {summary.folders.map((folder) => tab(folder.id, folder.name, folder.session_count))}
      {summary.folders.length > 0 ? tab('none', '未分组', summary.ungrouped) : null}
      {summary.folders.length < CHAT_FOLDER_LIMIT ? (
        <button
          type="button"
          onClick={onCreate}
          className={cn(CHIP, 'border border-dashed border-primary/40 text-primary')}
        >
          <Plus className="size-3.5" aria-hidden />
          {summary.folders.length === 0 ? '新建分组' : '新建'}
        </button>
      ) : null}
    </nav>
  );
}

/** 选中某个分组时，标签下方一行：名称 · 数量，低频的改名/删除收进「⋯」。 */
export function ActiveFolderBar({
  folder,
  onRename,
  onDelete,
}: {
  folder: ChatFolder;
  onRename: () => void;
  onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const act = (action: () => void) => {
    if (menuRef.current) menuRef.current.open = false;
    action();
  };
  return (
    <div className="mx-4 -mt-1 mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Folder className="size-3.5 text-primary/80" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {folder.name} · {folder.session_count} 个对话
      </span>
      <details
        ref={menuRef}
        className="relative shrink-0"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
      >
        <summary
          aria-label={`管理分组：${folder.name}`}
          className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        >
          <Ellipsis className="size-5" aria-hidden />
        </summary>
        <div className="absolute right-0 top-11 z-20 min-w-40 rounded-2xl border border-border bg-card p-1.5 shadow-xl">
          <button
            type="button"
            onClick={() => act(onRename)}
            className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs text-foreground hover:bg-secondary"
          >
            <Pencil className="size-4" aria-hidden />
            重命名分组
          </button>
          <button
            type="button"
            onClick={() => act(onDelete)}
            className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs text-destructive hover:bg-secondary"
          >
            <Trash2 className="size-4" aria-hidden />
            删除分组
          </button>
        </div>
      </details>
    </div>
  );
}
