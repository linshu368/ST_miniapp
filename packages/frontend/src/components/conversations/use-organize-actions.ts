'use client';

import { useCallback, useState } from 'react';
import type { ChatFolder, ChatSession, ConversationBatchAction } from '@miniapp/shared';

import {
  useConversationBatchMutation,
  useCreateFolderMutation,
  useDeleteFolderMutation,
  useRenameFolderMutation,
} from '@/lib/api/conversation-folders';
import { resolveSessionTitle, useUpdateConversationMutation } from '@/lib/api/conversations';
import type { ConversationView } from './use-conversation-view';

export type OrganizeSheet =
  | { kind: 'move'; ids: string[]; subject: string; current?: string | null }
  | { kind: 'create' }
  | { kind: 'rename'; folder: ChatFolder }
  | { kind: 'delete-folder'; folder: ChatFolder }
  | { kind: 'delete-batch'; ids: string[] }
  | null;

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error && error.message ? error.message : '操作未完成，请重试';
}

/** 整理用到的全部写操作；面板共用一份「处理中 / 错误」。 */
function useOrganizeMutations() {
  const createFolder = useCreateFolderMutation();
  const renameFolder = useRenameFolderMutation();
  const deleteFolder = useDeleteFolderMutation();
  const batch = useConversationBatchMutation();
  const update = useUpdateConversationMutation();
  const all = [createFolder, renameFolder, deleteFolder, batch, update];
  return {
    createFolder,
    renameFolder,
    deleteFolder,
    batch,
    update,
    pending: all.some((mutation) => mutation.isPending),
    error: errorText(all.find((mutation) => mutation.error)?.error),
    reset: () => all.forEach((mutation) => mutation.reset()),
  };
}

type Mutations = ReturnType<typeof useOrganizeMutations>;

/** 单条走 PATCH（保留原有单条语义与失效逻辑），多条走批量接口；成功后统一提示并退出管理模式。 */
function makeMoveTo(
  view: ConversationView,
  update: Mutations['update'],
  batch: Mutations['batch'],
  finish: (text: string) => void
) {
  return (
    ids: string[],
    folderId: string | null,
    single: boolean,
    newName?: string,
    after?: () => void
  ) => {
    const name = newName ?? (folderId ? view.folderNames.get(folderId) : null);
    if (single && ids[0]) {
      update.mutate(
        { sessionId: ids[0], folder_id: folderId },
        { onSuccess: () => finish(folderId ? `已放进「${name ?? '分组'}」` : '已移出分组') }
      );
      return;
    }
    batch.mutate(
      { session_ids: ids, action: 'move', folder_id: folderId },
      {
        onSuccess: ({ updated }) => {
          finish(
            folderId
              ? `已把 ${updated} 个对话放进「${name ?? '分组'}」`
              : `已把 ${updated} 个对话移出分组`
          );
          after?.();
        },
      }
    );
  };
}

export function useOrganizeActions(view: ConversationView) {
  const [sheet, setSheet] = useState<OrganizeSheet>(null);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const { createFolder, renameFolder, deleteFolder, batch, update, pending, error, reset } =
    useOrganizeMutations();
  const clearNotice = useCallback(() => setNotice(null), []);

  const open = (next: OrganizeSheet) => {
    reset();
    setSheet(next);
  };
  const finish = (text: string) => {
    setSheet(null);
    setNotice({ id: Date.now(), text });
    view.exitManage();
  };
  const selectedIds = () => [...view.selected];
  const runBatch = (action: ConversationBatchAction, ids: string[], text: (n: number) => string) =>
    batch.mutate(
      { session_ids: ids, action },
      { onSuccess: ({ updated }) => finish(text(updated)) }
    );

  const moveTo = makeMoveTo(view, update, batch, finish);

  return {
    sheet,
    close: () => setSheet(null),
    notice,
    clearNotice,
    pending,
    error,
    openMove: (session: ChatSession) =>
      open({
        kind: 'move',
        ids: [session.id],
        subject: resolveSessionTitle(session.title, '这段对话'),
        current: session.folder_id ?? null,
      }),
    openMoveSelected: () =>
      open({ kind: 'move', ids: selectedIds(), subject: `已选 ${view.selected.size} 个对话` }),
    openMoveIds: (ids: string[], subject: string) => open({ kind: 'move', ids, subject }),
    pinIds: (ids: string[], unpin: boolean) =>
      runBatch(unpin ? 'unpin' : 'pin', ids, () =>
        unpin ? '已取消置顶这个角色' : '已置顶这个角色'
      ),
    fail: (text: string) => setNotice({ id: Date.now(), text }),
    openCreate: () => open({ kind: 'create' }),
    openRename: (folder: ChatFolder) => open({ kind: 'rename', folder }),
    openDeleteFolder: (folder: ChatFolder) => open({ kind: 'delete-folder', folder }),
    openDeleteSelected: () => open({ kind: 'delete-batch', ids: selectedIds() }),
    pick: (folderId: string | null) => {
      if (sheet?.kind !== 'move') return;
      moveTo(sheet.ids, folderId, sheet.ids.length === 1 && !view.manage);
    },
    createAndMove: (name: string) => {
      if (sheet?.kind !== 'move') return;
      const { ids } = sheet;
      createFolder.mutate(name, {
        onSuccess: ({ folder }) =>
          moveTo(ids, folder.id, ids.length === 1 && !view.manage, folder.name),
      });
    },
    create: (name: string) =>
      createFolder.mutate(name, {
        onSuccess: ({ folder }) => {
          setSheet(null);
          // 新建后直接停在这个空分组，空状态会引导「挑选对话放进来」。
          view.selectFolder(folder.id);
          setNotice({ id: Date.now(), text: `已新建「${folder.name}」` });
        },
      }),
    rename: (name: string) => {
      if (sheet?.kind !== 'rename') return;
      renameFolder.mutate({ id: sheet.folder.id, name }, { onSuccess: () => finish('已重命名') });
    },
    removeFolder: () => {
      if (sheet?.kind !== 'delete-folder') return;
      deleteFolder.mutate(sheet.folder.id, {
        onSuccess: () => {
          view.selectFolder('all');
          finish('分组已删除，里面的对话都还在');
        },
      });
    },
    deleteSelected: () => {
      if (sheet?.kind !== 'delete-batch') return;
      runBatch('delete', sheet.ids, (n) => `已删除 ${n} 个对话`);
    },
    pinSelected: (unpin: boolean) =>
      runBatch(unpin ? 'unpin' : 'pin', selectedIds(), (n) =>
        unpin ? `已取消置顶 ${n} 个` : `已置顶 ${n} 个`
      ),
    putInTarget: () => {
      const target = view.manage?.target;
      if (target) {
        moveTo(selectedIds(), target.id, false, target.name, () => view.selectFolder(target.id));
      }
    },
  };
}

export type OrganizeActions = ReturnType<typeof useOrganizeActions>;
