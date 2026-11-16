'use client';

/**
 * 对话页（/chats）的列表、分组、按角色归拢与批量整理。
 * 所有 key 都挂在 conversationKeys.lists 前缀下：任何会话写操作按前缀失效，这里的列表也会一起刷新。
 */
import {
  keepPreviousData,
  queryOptions,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ChatFolder,
  ChatFolderSummary,
  ConversationBatchData,
  ConversationBatchRequest,
  ConversationQuickFilter,
  CreateChatFolderData,
  DeleteChatFolderData,
  ListConversationGroupsData,
  ListConversationsData,
  RenameChatFolderData,
} from '@miniapp/shared';
import { CONVERSATION_BATCH_LIMIT } from '@miniapp/shared';

import { rememberChatLanding } from '@/lib/landing-route';
import { apiClient } from './client';
import { conversationKeys } from './conversations';

const PAGE_SIZE = 20;
/** 管理模式的快捷筛选一次多取，方便一口气清理 */
const MANAGE_PAGE_SIZE = 100;

/** 'all' = 全部；'none' = 未分组；其余为分组 id */
export type FolderFilter = string;

export interface ConversationListFilter {
  folder: FolderFilter;
  q?: string;
  quick?: ConversationQuickFilter;
}

export const conversationListKeys = {
  pages: (filter: ConversationListFilter) =>
    [
      ...conversationKeys.lists,
      'pages',
      filter.folder,
      filter.q ?? '',
      filter.quick ?? '',
    ] as const,
  groups: (folder: FolderFilter) => [...conversationKeys.lists, 'groups', folder] as const,
  characterSessions: (characterId: string, folder: FolderFilter) =>
    [...conversationKeys.lists, 'character-sessions', characterId, folder] as const,
  /** 标签栏数量：由首页响应写入，本身不发请求 */
  summary: () => [...conversationKeys.lists, 'folder-summary'] as const,
};

function listSearch(filter: ConversationListFilter, offset: number, limit: number): string {
  const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  // 搜索不限分组：用户在「主线剧情」里搜不到时，大概率是在别的组里。
  if (filter.q) search.set('q', filter.q);
  else if (filter.folder !== 'all') search.set('folder', filter.folder);
  if (filter.quick) search.set('quick', filter.quick);
  if (offset === 0) search.set('summary', '1');
  return search.toString();
}

function keepSummary(queryClient: QueryClient, summary: ChatFolderSummary | undefined) {
  if (summary) queryClient.setQueryData(conversationListKeys.summary(), summary);
}

export function useFolderSummary(): ChatFolderSummary | undefined {
  return useQuery<ChatFolderSummary>({
    queryKey: conversationListKeys.summary(),
    queryFn: skipToken,
    staleTime: Infinity,
  }).data;
}

export function useConversationPages(filter: ConversationListFilter, enabled = true) {
  const queryClient = useQueryClient();
  const limit = filter.quick ? MANAGE_PAGE_SIZE : PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: conversationListKeys.pages(filter),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const data = await apiClient<ListConversationsData>(
        `/api/v1/conversations?${listSearch(filter, pageParam, limit)}`,
        { signal }
      );
      keepSummary(queryClient, data.folder_summary);
      if (pageParam === 0 && filter.folder === 'all' && !filter.q && !filter.quick) {
        rememberChatLanding(data.total > 0);
      }
      return data;
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.sessions.length, 0);
      return last.sessions.length > 0 && loaded < last.total ? loaded : undefined;
    },
    // 切标签/搜索时保留上一屏，避免列表闪空。
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useConversationGroups(folder: FolderFilter, enabled = true) {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: conversationListKeys.groups(folder),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageParam) });
      if (folder !== 'all') search.set('folder', folder);
      if (pageParam === 0) search.set('summary', '1');
      const data = await apiClient<ListConversationGroupsData>(
        `/api/v1/conversations/groups?${search.toString()}`,
        { signal }
      );
      keepSummary(queryClient, data.folder_summary);
      // 默认按角色时首屏走这里：同样据此记下「有对话记录」，下次打开直接进对话。
      if (pageParam === 0 && folder === 'all') rememberChatLanding(data.total > 0);
      return data;
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.groups.length, 0);
      return last.groups.length > 0 && loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** 某角色在当前范围（全部/某分组/未分组）里的全部段落：展开「N 段」和整组操作共用。 */
export function characterSessionsOptions(characterId: string, folder: FolderFilter) {
  return queryOptions<ListConversationsData>({
    queryKey: conversationListKeys.characterSessions(characterId, folder),
    queryFn: ({ signal }) => {
      const search = new URLSearchParams({ character_id: characterId, limit: '100' });
      if (folder !== 'all') search.set('folder', folder);
      return apiClient<ListConversationsData>(`/api/v1/conversations?${search.toString()}`, {
        signal,
      });
    },
    staleTime: 30_000,
  });
}

/** 展开「N 段」时才取该角色的全部段落（沿用按角色列表接口）。 */
export function useCharacterSessions(characterId: string, folder: FolderFilter, enabled: boolean) {
  return useQuery({ ...characterSessionsOptions(characterId, folder), enabled });
}

function useInvalidateLists() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: conversationKeys.lists });
}

/**
 * 分组增改删成功后先就地改标签栏汇总，再整体失效刷新：
 * 否则新建后跳到新分组时，旧汇总里还没有它，会被当成「分组已不存在」退回全部。
 */
function useEditSummary() {
  const queryClient = useQueryClient();
  return (edit: (folders: ChatFolder[]) => ChatFolder[]) =>
    queryClient.setQueryData<ChatFolderSummary>(conversationListKeys.summary(), (current) =>
      current ? { ...current, folders: edit(current.folders) } : current
    );
}

export function useCreateFolderMutation() {
  const invalidate = useInvalidateLists();
  const editSummary = useEditSummary();
  return useMutation({
    mutationFn: (name: string) =>
      apiClient<CreateChatFolderData>('/api/v1/conversation-folders', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: ({ folder }) => {
      editSummary((folders) => [...folders, folder]);
      void invalidate();
    },
  });
}

export function useRenameFolderMutation() {
  const invalidate = useInvalidateLists();
  const editSummary = useEditSummary();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiClient<RenameChatFolderData>(`/api/v1/conversation-folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: ({ folder }) => {
      editSummary((folders) => folders.map((item) => (item.id === folder.id ? folder : item)));
      void invalidate();
    },
  });
}

export function useDeleteFolderMutation() {
  const invalidate = useInvalidateLists();
  const editSummary = useEditSummary();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient<DeleteChatFolderData>(`/api/v1/conversation-folders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: ({ id }) => {
      editSummary((folders) => folders.filter((item) => item.id !== id));
      void invalidate();
    },
  });
}

/** 超过单次上限时按 100 条一批顺序提交；任何一批失败即停止并抛出，已生效的部分以刷新后的列表为准。 */
export function useConversationBatchMutation() {
  const invalidate = useInvalidateLists();
  return useMutation({
    mutationFn: async (input: ConversationBatchRequest) => {
      let updated = 0;
      for (let start = 0; start < input.session_ids.length; start += CONVERSATION_BATCH_LIMIT) {
        const chunk = input.session_ids.slice(start, start + CONVERSATION_BATCH_LIMIT);
        const data = await apiClient<ConversationBatchData>('/api/v1/conversations/batch', {
          method: 'POST',
          body: JSON.stringify({ ...input, session_ids: chunk }),
        });
        updated += data.updated;
      }
      return { updated };
    },
    onSettled: () => void invalidate(),
  });
}
