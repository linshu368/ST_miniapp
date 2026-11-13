'use client';

import { useEffect } from 'react';
import { Search } from 'lucide-react';

import { RoleplayHeader } from '@/components/roleplay/roleplay-header';
import { markCriticalSettled } from '@/lib/entry-phase';
import { usePageReady } from '@/lib/perf/page-ready';
import { cn } from '@/lib/utils';
import { useRevealReturn } from './chats-return';
import { ConversationListBody } from './conversation-list-body';
import { useLobbySummaryLookup } from './conversation-row';
import { ConfirmSheet, FolderNameSheet, MoveSheet } from './folder-sheets';
import { ActiveFolderBar, FolderTabs } from './folder-tabs';
import { ManageBar, ManageHeader } from './manage-mode';
import { useConversationView, type ConversationView } from './use-conversation-view';
import { useOrganizeActions, type OrganizeActions } from './use-organize-actions';

const TOOL_BUTTON =
  'min-h-10 shrink-0 rounded-2xl px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * 对话页：有对话记录用户的落地页，首要任务是「接着聊」。
 * 杂而不乱：列表永远是主体；对话少时工具不出现；工具只有一排搜索+两个文字按钮、一排分组标签；
 * 低频操作收进「⋯」；管理是独立模式。
 */
export function ConversationListPage() {
  const view = useConversationView();
  const actions = useOrganizeActions(view);
  const lookup = useLobbySummaryLookup();
  const query = view.grouped ? view.groups : view.pages;
  const ready = query.data !== undefined;
  const rows = view.grouped ? view.groupRows.length : view.sessions.length;
  usePageReady('/chats', ready && (!query.isError || rows > 0), false, query.isError);
  // 有对话记录的用户冷启动落在这里：列表结算后放行收藏、角标等次要请求，不必等 8 秒兜底。
  useEffect(() => {
    if (ready || query.isError) markCriticalSettled();
  }, [ready, query.isError]);
  // 从聊天返回：回到点开的那一行并闪金边；否则沿用原有的按滚动位置恢复。
  const flashId = useRevealReturn(view.returnAnchor, ready && !query.isPlaceholderData);

  const activeFolder = view.summary?.folders.find((item) => item.id === view.folder);

  return (
    <main
      className={cn(
        'min-h-[calc(100dvh-var(--app-nav-space))] bg-background text-foreground',
        view.manage ? 'pb-28' : 'pb-8'
      )}
    >
      {view.manage ? (
        <div className="sticky top-0 z-30 border-b border-border/70 bg-background pt-[calc(0.5rem+env(safe-area-inset-top))]">
          <ManageHeader
            selectedCount={view.selected.size}
            allSelected={
              view.sessions.length > 0 && view.sessions.every((s) => view.selected.has(s.id))
            }
            hasRows={view.sessions.length > 0}
            quick={view.manage.quick}
            targetName={view.manage.target?.name}
            onToggleAll={view.toggleAll}
            onQuick={view.setQuick}
            onDone={view.exitManage}
          />
        </div>
      ) : (
        <RoleplayHeader active="conversations" />
      )}

      {view.manage ? null : <Toolbar view={view} />}
      {!view.manage && view.toolsVisible && view.summary && !view.q ? (
        <FolderTabs
          summary={view.summary}
          active={view.folder}
          onSelect={view.selectFolder}
          onCreate={actions.openCreate}
        />
      ) : null}
      {!view.manage && activeFolder && !view.q ? (
        <ActiveFolderBar
          folder={activeFolder}
          onRename={() => actions.openRename(activeFolder)}
          onDelete={() => actions.openDeleteFolder(activeFolder)}
        />
      ) : null}

      <section aria-label="对话记录" className="mx-auto w-full max-w-2xl px-4 pt-1">
        <ConversationListBody
          view={view}
          lookup={lookup}
          activeFolder={activeFolder}
          onMove={actions.openMove}
          onPickForFolder={(folder) => view.enterManage({ target: folder })}
          groupActions={{ move: actions.openMoveIds, pin: actions.pinIds, fail: actions.fail }}
          flashId={flashId}
        />
      </section>

      {view.manage ? <ManageActions view={view} actions={actions} /> : null}
      <OrganizeSheets view={view} actions={actions} />
      <Notice actions={actions} />
    </main>
  );
}

function Toolbar({ view }: { view: ConversationView }) {
  if (!view.toolsVisible) {
    return (
      <p className="mx-auto w-full max-w-2xl px-4 pb-2 pt-2 text-xs text-muted-foreground">
        继续你的故事，也可以在这里管理对话。
      </p>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 pb-3 pt-2.5">
      <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-2xl bg-secondary px-3 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
        <Search className="size-4 shrink-0" aria-hidden />
        <input
          type="search"
          value={view.search}
          onChange={(event) => view.setSearch(event.target.value)}
          maxLength={30}
          placeholder="搜对话名"
          aria-label="搜索对话"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      {view.summary ? (
        <button
          type="button"
          aria-pressed={view.byCharacter}
          onClick={view.toggleByCharacter}
          className={cn(
            TOOL_BUTTON,
            view.byCharacter
              ? 'bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/40'
              : 'bg-secondary text-foreground'
          )}
        >
          按角色
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => view.enterManage()}
        className={cn(TOOL_BUTTON, 'bg-secondary text-foreground')}
      >
        管理
      </button>
    </div>
  );
}

function ManageActions({ view, actions }: { view: ConversationView; actions: OrganizeActions }) {
  const chosen = view.sessions.filter((session) => view.selected.has(session.id));
  return (
    <ManageBar
      selectedCount={view.selected.size}
      allPinned={chosen.length > 0 && chosen.every((session) => session.pinned_at)}
      pending={actions.pending}
      targetName={view.manage?.target?.name}
      onMove={actions.openMoveSelected}
      onPin={() => actions.pinSelected(chosen.every((session) => session.pinned_at))}
      onDelete={actions.openDeleteSelected}
      onPutInTarget={actions.putInTarget}
    />
  );
}

function OrganizeSheets({ view, actions }: { view: ConversationView; actions: OrganizeActions }) {
  const { sheet } = actions;
  const common = { onClose: actions.close, pending: actions.pending, error: actions.error };
  return (
    <>
      <MoveSheet
        {...common}
        open={sheet?.kind === 'move'}
        subject={sheet?.kind === 'move' ? sheet.subject : ''}
        currentFolderId={sheet?.kind === 'move' ? sheet.current : undefined}
        folders={view.summary?.folders ?? []}
        onPick={actions.pick}
        onCreateAndMove={actions.createAndMove}
      />
      <FolderNameSheet
        {...common}
        open={sheet?.kind === 'create' || sheet?.kind === 'rename'}
        title={sheet?.kind === 'rename' ? '重命名分组' : '新建分组'}
        initial={sheet?.kind === 'rename' ? sheet.folder.name : ''}
        onSubmit={sheet?.kind === 'rename' ? actions.rename : actions.create}
      />
      <ConfirmSheet
        {...common}
        open={sheet?.kind === 'delete-folder'}
        title={sheet?.kind === 'delete-folder' ? `删除分组「${sheet.folder.name}」？` : ''}
        description="组里的对话不会删除，会回到「未分组」。"
        confirmLabel="删除分组"
        onConfirm={actions.removeFolder}
      />
      <ConfirmSheet
        {...common}
        open={sheet?.kind === 'delete-batch'}
        title={sheet?.kind === 'delete-batch' ? `删除 ${sheet.ids.length} 个对话？` : ''}
        description="删除后聊天记录无法恢复。"
        confirmLabel="删除"
        destructive
        onConfirm={actions.deleteSelected}
      />
    </>
  );
}

/** 操作完成的轻提示：底栏上方停 2 秒。只用透明度过渡，不用毛玻璃。 */
function Notice({ actions }: { actions: OrganizeActions }) {
  const { notice, clearNotice } = actions;
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clearNotice, 2000);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-4 bottom-[calc(var(--app-nav-space)+0.75rem)] z-40 mx-auto max-w-sm rounded-2xl border border-border bg-card px-4 py-2.5 text-center text-[12px] shadow-lg transition-opacity duration-200',
        notice ? 'opacity-100' : 'opacity-0'
      )}
    >
      {notice?.text}
    </div>
  );
}
