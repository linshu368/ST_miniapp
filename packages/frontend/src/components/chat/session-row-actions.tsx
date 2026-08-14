'use client';

// 会话行的操作：置顶、重命名、删除。
//
// 「历史聊天」页（/chats）和角色内的「对话记录」抽屉对同一条会话提供同一套操作，
// 差别只在排版密度。行为和文案收在这里，两个入口各自只负责长什么样——
// 否则下次加「归档」、把删除确认换成 Dialog、给失败补 toast 都要改两处，
// 漏一处就出现「同一会话在两个入口行为不同」。

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { ChatSession } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import {
  useDeleteConversationMutation,
  useUpdateConversationMutation,
} from '@/lib/api/conversations';

/** 抽屉窄、列表宽，同一组控件两个密度 */
type Density = 'compact' | 'comfortable';

export interface SessionRowActions {
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  startRename: () => void;
  cancelRename: () => void;
  commitRename: () => void;
  togglePin: () => void;
  confirmingDelete: boolean;
  toggleDeleteConfirm: () => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
}

export function useSessionRowActions(session: ChatSession): SessionRowActions {
  const update = useUpdateConversationMutation();
  const remove = useDeleteConversationMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return {
    editing,
    draft,
    setDraft,
    startRename: () => {
      setConfirmingDelete(false);
      setDraft(session.title ?? '');
      setEditing(true);
    },
    cancelRename: () => setEditing(false),
    commitRename: () => {
      const next = draft.trim();
      setEditing(false);
      // 清空即回到「按首条消息自动命名」，契约上就是传 null
      update.mutate({ sessionId: session.id, title: next.length > 0 ? next : null });
    },
    togglePin: () => update.mutate({ sessionId: session.id, pinned: !session.pinned_at }),
    confirmingDelete,
    toggleDeleteConfirm: () => setConfirmingDelete((current) => !current),
    cancelDelete: () => setConfirmingDelete(false),
    confirmDelete: () => {
      setConfirmingDelete(false);
      remove.mutate(session.id);
    },
  };
}

export function SessionActionButton({
  label,
  onClick,
  density = 'comfortable',
  children,
}: {
  label: string;
  onClick: () => void;
  density?: Density;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&_svg]:shrink-0',
        density === 'compact' ? 'size-8 [&_svg]:size-3.5' : 'size-9 [&_svg]:size-4'
      )}
    >
      {children}
    </button>
  );
}

export function SessionRenameField({
  actions,
  density = 'comfortable',
}: {
  actions: SessionRowActions;
  density?: Density;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        value={actions.draft}
        onChange={(event) => actions.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') actions.commitRename();
          if (event.key === 'Escape') actions.cancelRename();
        }}
        maxLength={60}
        placeholder="留空则回到自动命名"
        aria-label="对话名称"
        autoFocus
        className={cn(
          'min-w-0 flex-1 border border-border bg-background text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          density === 'compact'
            ? 'rounded-lg px-2 py-1.5 text-[13px]'
            : 'rounded-xl px-3 py-2 text-sm'
        )}
      />
      <SessionActionButton label="保存" onClick={actions.commitRename} density={density}>
        <Check aria-hidden />
      </SessionActionButton>
      <SessionActionButton label="取消" onClick={actions.cancelRename} density={density}>
        <X aria-hidden />
      </SessionActionButton>
    </div>
  );
}

/** 删除不可逆，且这两个入口都没有撤销位，必须再问一次 */
export function SessionDeleteConfirm({
  actions,
  density = 'comfortable',
  className,
}: {
  actions: SessionRowActions;
  density?: Density;
  className?: string;
}) {
  const compact = density === 'compact';

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 border-t border-border/60',
        compact ? 'mt-2 pt-2' : 'mt-3 pt-3',
        className
      )}
    >
      <span className={cn('text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>
        删除这段对话？
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={actions.cancelDelete}
          className={cn(
            'rounded-full text-muted-foreground hover:bg-secondary',
            compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
          )}
        >
          取消
        </button>
        <button
          type="button"
          onClick={actions.confirmDelete}
          className={cn(
            'rounded-full bg-destructive font-semibold text-destructive-foreground',
            compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
          )}
        >
          删除
        </button>
      </span>
    </div>
  );
}
