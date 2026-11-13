'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { FolderPlus, MessageCircle, RefreshCw } from 'lucide-react';
import type { ChatFolder, ChatSession } from '@miniapp/shared';

import { ConversationGroupRow, type GroupActions } from './conversation-group-row';
import { ConversationRow, type LobbySummaryLookup } from './conversation-row';
import type { ConversationView } from './use-conversation-view';

const PRIMARY_PILL =
  'mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-95';

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-8 text-center text-sm leading-relaxed text-muted-foreground">
      {children}
    </div>
  );
}

function LoadError({ onRetry, text }: { onRetry: () => void; text: string }) {
  return (
    <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
      <p className="text-sm text-destructive">{text}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        <RefreshCw className="size-4" aria-hidden />
        重试
      </button>
    </div>
  );
}

/** 每个空状态都给下一步，不让用户停在空白处不知道干什么。 */
function EmptyState({
  view,
  activeFolder,
  onPickForFolder,
}: {
  view: ConversationView;
  activeFolder?: ChatFolder;
  onPickForFolder: (folder: ChatFolder) => void;
}) {
  if (view.q) return <Hint>没找到「{view.q}」相关的对话，换个词试试</Hint>;
  if (view.manage?.quick) return <Hint>没有符合条件的对话，已经很清爽了</Hint>;
  if (activeFolder) {
    return (
      <Hint>
        「{activeFolder.name}」还是空的
        <br />
        把同一类的对话放进来，以后一眼就能找到
        <br />
        <button
          type="button"
          onClick={() => onPickForFolder(activeFolder)}
          className={PRIMARY_PILL}
        >
          <FolderPlus className="size-4" aria-hidden />
          挑选对话放进来
        </button>
      </Hint>
    );
  }
  if (view.folder === 'none') return <Hint>对话都已经归好组了</Hint>;
  return (
    <div className="rounded-3xl border border-border bg-card p-8 text-center">
      <MessageCircle className="mx-auto size-9 text-primary" aria-hidden />
      <h2 className="mt-3 font-semibold">还没有对话</h2>
      <p className="mt-1 text-sm text-muted-foreground">选一个喜欢的角色，开始你的第一段故事。</p>
      <Link href="/characters" className={PRIMARY_PILL}>
        去发现角色
      </Link>
    </div>
  );
}

/** 列表底部哨兵：提前 600px 触发下一页，用户滑到底时通常已经加载好。 */
function LoadMore({
  hasNext,
  fetching,
  failed,
  onLoad,
}: {
  hasNext: boolean;
  fetching: boolean;
  failed: boolean;
  onLoad: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !hasNext || failed || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !fetching) onLoad();
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNext, fetching, failed, onLoad]);
  if (!hasNext) return null;
  return (
    <div ref={ref} className="py-3 text-center text-xs text-muted-foreground">
      {failed ? (
        <button type="button" onClick={onLoad} className="min-h-11 px-3 text-primary">
          加载失败，点此重试
        </button>
      ) : (
        '正在加载更早的对话…'
      )}
    </div>
  );
}

export function ConversationListBody({
  view,
  lookup,
  activeFolder,
  onMove,
  onPickForFolder,
  groupActions,
  flashId,
}: {
  view: ConversationView;
  lookup: LobbySummaryLookup;
  activeFolder?: ChatFolder;
  onMove: (session: ChatSession) => void;
  onPickForFolder: (folder: ChatFolder) => void;
  groupActions: GroupActions;
  flashId: string | null;
}) {
  const query = view.grouped ? view.groups : view.pages;
  const count = view.grouped ? view.groupRows.length : view.sessions.length;
  // 「全部」和搜索结果里才标所属分组；在分组里看时不重复显示。
  const showFolderTag = view.folder === 'all' || Boolean(view.q) || Boolean(view.manage?.target);
  const labelOf = (session: ChatSession) =>
    showFolderTag && session.folder_id ? view.folderNames.get(session.folder_id) : undefined;

  if (query.isLoading && count === 0) return <Hint>正在读取历史对话…</Hint>;
  if (query.isError && count === 0) {
    return <LoadError text="对话没加载出来，点一下再试试。" onRetry={() => void query.refetch()} />;
  }
  if (count === 0) {
    return <EmptyState view={view} activeFolder={activeFolder} onPickForFolder={onPickForFolder} />;
  }

  return (
    <>
      <div className="space-y-2" aria-busy={query.isPlaceholderData}>
        {view.grouped
          ? view.groupRows.map((group) =>
              group.session_count > 1 ? (
                <ConversationGroupRow
                  key={group.session.character_id}
                  group={group}
                  folder={view.folder}
                  lookup={lookup}
                  onMove={onMove}
                  groupActions={groupActions}
                  open={view.expanded.has(group.session.character_id)}
                  onToggle={() => view.toggleExpanded(group.session.character_id)}
                  onOpen={view.rememberReturn}
                  flashId={flashId}
                />
              ) : (
                <ConversationRow
                  key={group.session.id}
                  session={group.session}
                  lookup={lookup}
                  folderLabel={labelOf(group.session)}
                  onMove={onMove}
                  onOpen={view.rememberReturn}
                  flash={flashId === group.session.id}
                />
              )
            )
          : view.sessions.map((session) => (
              <ConversationRow
                key={session.id}
                session={session}
                lookup={lookup}
                folderLabel={labelOf(session)}
                onMove={onMove}
                onOpen={view.rememberReturn}
                flash={flashId === session.id}
                selection={
                  view.manage
                    ? {
                        selected: view.selected.has(session.id),
                        onToggle: () => view.toggleSelected(session.id),
                      }
                    : undefined
                }
              />
            ))}
      </div>
      <LoadMore
        hasNext={Boolean(query.hasNextPage)}
        fetching={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoad={() => void query.fetchNextPage()}
      />
    </>
  );
}
