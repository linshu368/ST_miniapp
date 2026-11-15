'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatFolder, ChatSession, ConversationQuickFilter } from '@miniapp/shared';

import { ApiClientError } from '@/lib/api/client';
import {
  useConversationGroups,
  useConversationPages,
  useFolderSummary,
  type ConversationListFilter,
  type FolderFilter,
} from '@/lib/api/conversation-folders';
import { clearChatsReturn, peekChatsReturn, rememberChatsReturn } from './chats-return';

const BY_CHARACTER_KEY = 'st.chats.byCharacter';
/** 对话少于这个数且没建过分组时，工具一律不出现，页面保持原样 */
export const TOOLS_MIN_CONVERSATIONS = 6;

export interface ManageState {
  quick?: ConversationQuickFilter;
  /** 从空分组「挑选对话放进来」进入时的目标分组 */
  target?: ChatFolder;
}

/** 默认按角色归拢；用户关掉后记在本机。 */
function useByCharacter(): [boolean, () => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(BY_CHARACTER_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggle = useCallback(() => {
    setValue((current) => {
      try {
        window.localStorage.setItem(BY_CHARACTER_KEY, current ? '0' : '1');
      } catch {
        // 本机存不了就只在本次生效。
      }
      return !current;
    });
  }, []);
  return [value, toggle];
}

function groupsUnavailable(error: unknown): boolean {
  return error instanceof ApiClientError && [404, 503].includes(error.status);
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useConversationView() {
  // 从聊天返回时恢复点开前的分组、搜索与展开；peek 在初始化里读（StrictMode 双挂载都能拿到），挂载后清掉。
  const [restored] = useState(peekChatsReturn);
  useEffect(clearChatsReturn, []);
  const [folder, setFolder] = useState<FolderFilter>(restored?.folder ?? 'all');
  const [search, setSearch] = useState(restored?.search ?? '');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(restored?.expanded));
  const q = useDebouncedValue(search.trim(), 300);
  const [byCharacter, toggleByCharacter] = useByCharacter();
  const [manage, setManage] = useState<ManageState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const summary = useFolderSummary();

  // 搜索与管理模式一律平铺：搜索要逐条看结果，勾选要一条一条选。
  // 归拢接口不可用（迁移未执行 503；前端先于后端上线的几分钟里旧后端 404）时直接退回平铺。
  const wantsGroups = byCharacter && !q && !manage;
  const groups = useConversationGroups(folder, wantsGroups);
  const grouped = wantsGroups && !groupsUnavailable(groups.error);
  const listFilter: ConversationListFilter = manage
    ? { folder: manage.target ? 'all' : folder, quick: manage.quick }
    : { folder, q: q || undefined };
  const pages = useConversationPages(listFilter, !grouped);
  const sessions = useMemo<ChatSession[]>(
    () => pages.data?.pages.flatMap((page) => page.sessions) ?? [],
    [pages.data]
  );
  const groupRows = useMemo(
    () => groups.data?.pages.flatMap((page) => page.groups) ?? [],
    [groups.data]
  );

  // 当前分组被删（或在别处改名后不存在）时回到「全部」，不留在一个空壳标签上。
  useEffect(() => {
    if (!summary || folder === 'all' || folder === 'none') return;
    if (!summary.folders.some((item) => item.id === folder)) setFolder('all');
  }, [summary, folder]);

  // 快捷筛选的意图就是「把这些都选上」：结果到达后自动全选，用户再按需取消个别。
  const autoSelectFor = useRef<string | null>(null);
  useEffect(() => {
    const quick = manage?.quick ?? null;
    if (!quick || pages.isPlaceholderData || autoSelectFor.current !== quick) return;
    autoSelectFor.current = null;
    setSelected(new Set(sessions.map((session) => session.id)));
  }, [manage?.quick, pages.isPlaceholderData, sessions]);

  const total = summary?.all ?? pages.data?.pages[0]?.total ?? 0;
  const folderNames = useMemo(
    () => new Map(summary?.folders.map((item) => [item.id, item.name]) ?? []),
    [summary]
  );

  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return {
    folder,
    selectFolder: (next: FolderFilter) => {
      setFolder(next);
      setSearch('');
    },
    search,
    setSearch,
    q,
    byCharacter,
    toggleByCharacter,
    grouped,
    expanded,
    toggleExpanded: (characterId: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(characterId)) next.delete(characterId);
        else next.add(characterId);
        return next;
      }),
    returnAnchor: restored?.anchorId ?? null,
    /** 点开某段对话前调用：记下现在的位置，返回时原样恢复 */
    rememberReturn: (anchorId: string) =>
      rememberChatsReturn({ folder, search, expanded: [...expanded], anchorId }),
    manage,
    enterManage: (state: ManageState = {}) => {
      setSearch('');
      setSelected(new Set());
      setManage(state);
    },
    setQuick: (quick: ConversationQuickFilter | undefined) => {
      autoSelectFor.current = quick ?? null;
      setSelected(new Set());
      setManage((current) => (current ? { ...current, quick } : current));
    },
    exitManage: () => {
      setManage(null);
      setSelected(new Set());
    },
    selected,
    toggleSelected,
    toggleAll: () => {
      const all = sessions.length > 0 && sessions.every((session) => selected.has(session.id));
      setSelected(all ? new Set() : new Set(sessions.map((session) => session.id)));
    },
    summary,
    folderNames,
    toolsVisible:
      Boolean(manage) ||
      search.length > 0 ||
      total >= TOOLS_MIN_CONVERSATIONS ||
      (summary?.folders.length ?? 0) > 0,
    pages,
    groups,
    sessions,
    groupRows,
  };
}

export type ConversationView = ReturnType<typeof useConversationView>;
