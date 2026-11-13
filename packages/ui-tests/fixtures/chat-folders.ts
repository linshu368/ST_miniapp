import { randomUUID } from 'node:crypto';
import {
  CHAT_FOLDER_LIMIT,
  CONVERSATION_QUICK_FILTERS,
  ConversationBatchRequestSchema,
  CreateChatFolderRequestSchema,
  type ChatFolderSummary,
  type ChatSession,
  type CharacterDetail,
  type ConversationQuickFilter,
} from '@miniapp/shared';

export interface FixtureFolder {
  id: string;
  name: string;
  created_at: string;
}

type Result = { status: number; data?: unknown; code?: string; message?: string } | null;

const FOLDER_PATH = /^\/api\/v1\/conversation-folders(?:\/([^/]+))?$/;
const visible = (session: ChatSession) => session.message_count > 0;

function sortSessions(rows: ChatSession[]): ChatSession[] {
  return [...rows].sort(
    (a, b) =>
      (b.pinned_at ?? '').localeCompare(a.pinned_at ?? '') ||
      (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '') ||
      b.created_at.localeCompare(a.created_at)
  );
}

function page<T>(rows: T[], url: URL, fallback = 20) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? fallback) || fallback, 100);
  const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
  return { rows: rows.slice(offset, offset + limit), offset };
}

/** 与 Backend 同口径的内存实现：分组、搜索、快捷筛选、按角色归拢、批量整理。 */
export function createChatFolderFixture() {
  let folders: FixtureFolder[] = [];

  const summary = (sessions: ChatSession[]): ChatFolderSummary => {
    const shown = sessions.filter(visible);
    return {
      all: shown.length,
      ungrouped: shown.filter((s) => !s.folder_id).length,
      folders: folders.map((folder) => ({
        ...folder,
        session_count: shown.filter((s) => s.folder_id === folder.id).length,
      })),
    };
  };

  const filterRows = (sessions: ChatSession[], url: URL): ChatSession[] | null => {
    const folder = url.searchParams.get('folder');
    const q = url.searchParams.get('q')?.trim();
    const quick = url.searchParams.get('quick');
    const characterId = url.searchParams.get('character_id');
    if (quick && !CONVERSATION_QUICK_FILTERS.includes(quick as ConversationQuickFilter))
      return null;
    return sessions.filter(
      (s) =>
        visible(s) &&
        (!characterId || s.character_id === characterId) &&
        (q
          ? (s.title ?? '').toLowerCase().includes(q.toLowerCase())
          : !folder || (folder === 'none' ? !s.folder_id : s.folder_id === folder)) &&
        (quick !== 'short' || s.message_count <= 2) &&
        (quick !== 'idle' || Date.parse(s.last_message_at ?? '') < Date.now() - 30 * 86_400_000)
    );
  };

  return {
    reset(seed: FixtureFolder[] = []) {
      folders = seed.map((folder) => ({ ...folder }));
    },
    has(id: string) {
      return folders.some((folder) => folder.id === id);
    },
    handle(method: string, path: string, url: URL, body: unknown, sessions: ChatSession[]): Result {
      if (path === '/api/v1/conversations' && method === 'GET') {
        const rows = filterRows(sessions, url);
        if (!rows) return { status: 400, code: 'BAD_REQUEST', message: '筛选条件无效' };
        const sorted = sortSessions(rows);
        const { rows: slice, offset } = page(sorted, url);
        const wantsSummary =
          url.searchParams.get('summary') === '1' &&
          !url.searchParams.get('character_id') &&
          !offset;
        return {
          status: 200,
          data: {
            sessions: slice,
            total: sorted.length,
            ...(wantsSummary ? { folder_summary: summary(sessions) } : {}),
          },
        };
      }
      if (path === '/api/v1/conversations/groups' && method === 'GET') {
        // 归拢只认分组条件；搜索与快捷筛选在前端一律走平铺列表。
        const scoped = new URL(url.pathname, url.origin);
        const folderParam = url.searchParams.get('folder');
        if (folderParam) scoped.searchParams.set('folder', folderParam);
        const rows = filterRows(sessions, scoped);
        // 与 list_chat_session_groups 同口径：代表段为最新一段，任一段置顶即整组置顶。
        const byCharacter = new Map<string, ChatSession[]>();
        const latestFirst = [...(rows ?? [])].sort(
          (a, b) =>
            (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '') ||
            b.created_at.localeCompare(a.created_at)
        );
        for (const session of latestFirst) {
          byCharacter.set(session.character_id, [
            ...(byCharacter.get(session.character_id) ?? []),
            session,
          ]);
        }
        const groups = [...byCharacter.values()]
          .map((group) => ({
            session: group[0]!,
            session_count: group.length,
            pinned_at:
              group
                .map((item) => item.pinned_at)
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1) ?? null,
          }))
          .sort(
            (a, b) =>
              (b.pinned_at ?? '').localeCompare(a.pinned_at ?? '') ||
              (b.session.last_message_at ?? '').localeCompare(a.session.last_message_at ?? '')
          );
        const { rows: slice, offset } = page(groups, url);
        return {
          status: 200,
          data: {
            groups: slice,
            total: groups.length,
            ...(url.searchParams.get('summary') === '1' && !offset
              ? { folder_summary: summary(sessions) }
              : {}),
          },
        };
      }
      if (path === '/api/v1/conversations/batch' && method === 'POST') {
        const parsed = ConversationBatchRequestSchema.safeParse(body);
        if (!parsed.success)
          return { status: 400, code: 'BAD_REQUEST', message: '批量操作参数无效' };
        const { session_ids: ids, action, folder_id: folderId } = parsed.data;
        if (action === 'move' && folderId && !this.has(folderId)) {
          return { status: 404, code: 'folder_not_found', message: '分组不存在' };
        }
        const targets = sessions.filter((s) => ids.includes(s.id) && visible(s));
        const now = new Date().toISOString();
        for (const session of targets) {
          if (action === 'move') session.folder_id = folderId ?? null;
          if (action === 'pin') session.pinned_at = now;
          if (action === 'unpin') session.pinned_at = null;
          session.updated_at = now;
        }
        if (action === 'delete') {
          for (const session of targets) sessions.splice(sessions.indexOf(session), 1);
        }
        return { status: 200, data: { updated: targets.length } };
      }
      const match = path.match(FOLDER_PATH);
      if (!match) return null;
      const id = match[1];
      if (!id && method === 'POST') {
        const parsed = CreateChatFolderRequestSchema.safeParse(body);
        if (!parsed.success)
          return { status: 400, code: 'BAD_REQUEST', message: '分组名需要 1–12 个字' };
        if (folders.length >= CHAT_FOLDER_LIMIT) {
          return {
            status: 409,
            code: 'folder_limit',
            message: `最多建 ${CHAT_FOLDER_LIMIT} 个分组`,
          };
        }
        if (folders.some((folder) => folder.name === parsed.data.name)) {
          return { status: 409, code: 'folder_name_taken', message: '已经有同名分组' };
        }
        const folder = {
          id: randomUUID(),
          name: parsed.data.name,
          created_at: new Date().toISOString(),
        };
        folders.push(folder);
        return { status: 200, data: { folder: { ...folder, session_count: 0 } } };
      }
      const folder = folders.find((item) => item.id === id);
      if (!folder) return { status: 404, code: 'folder_not_found', message: '分组不存在' };
      if (method === 'PATCH') {
        const parsed = CreateChatFolderRequestSchema.safeParse(body);
        if (!parsed.success)
          return { status: 400, code: 'BAD_REQUEST', message: '分组名需要 1–12 个字' };
        if (folders.some((item) => item.id !== id && item.name === parsed.data.name)) {
          return { status: 409, code: 'folder_name_taken', message: '已经有同名分组' };
        }
        folder.name = parsed.data.name;
        const count = sessions.filter((s) => visible(s) && s.folder_id === id).length;
        return { status: 200, data: { folder: { ...folder, session_count: count } } };
      }
      if (method === 'DELETE') {
        folders = folders.filter((item) => item.id !== id);
        for (const session of sessions) if (session.folder_id === id) session.folder_id = null;
        return { status: 200, data: { id } };
      }
      return null;
    },
  };
}

const TITLES = [
  '雾城来信',
  '长安月未央',
  '青梅竹马',
  '星海舰长',
  '夜班医生',
  '古堡管家',
  '赛博猎人',
  '狐妖小白',
];

/** chat-folders 场景：32 段对话、多角色多段、2 个分组、若干只聊一两句与 30 天未聊。 */
export function makeFolderSessionSamples(
  base: ChatSession,
  characters: CharacterDetail[]
): { sessions: ChatSession[]; folders: FixtureFolder[] } {
  const folders: FixtureFolder[] = [
    {
      id: '61000000-0000-4000-8000-000000000001',
      name: '主线剧情',
      created_at: '2026-11-01T08:00:00.000Z',
    },
    {
      id: '61000000-0000-4000-8000-000000000002',
      name: '恋爱向',
      created_at: '2026-11-02T08:00:00.000Z',
    },
  ];
  const sessions = Array.from({ length: 32 }, (_, index): ChatSession => {
    // 前 4 个角色各 3 段（便于看归拢），其余一人一段。
    const character =
      characters[index < 12 ? index % 4 : 4 + ((index - 12) % (characters.length - 4))]!;
    const at = new Date(
      Date.now() - (index * 3 + 1) * 3_600_000 * (index > 24 ? 20 : 1)
    ).toISOString();
    const part = index < 12 ? Math.floor(index / 4) + 1 : 1;
    return {
      ...base,
      id: `62000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      character_id: character.id,
      title: part > 1 ? `${character.name} · 第${part}段` : character.name,
      created_at: at,
      updated_at: at,
      last_message_at: at,
      last_message_preview: `${TITLES[index % TITLES.length]}：这一段停在了第 ${index + 3} 轮。`,
      message_count: index % 5 === 4 ? 1 : 6 + index,
      pinned_at: index === 2 ? new Date(Date.now() - 600_000).toISOString() : null,
      folder_id: index % 7 === 0 ? folders[0]!.id : index % 9 === 1 ? folders[1]!.id : null,
    };
  });
  return { sessions, folders };
}
