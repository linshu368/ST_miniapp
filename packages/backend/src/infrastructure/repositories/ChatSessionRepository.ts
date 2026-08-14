// 自研引擎对话会话仓库（M1）。
//
// 方案：docs/ST_remove-MVP实施方案.md §5.1 / §5.2 / §5.7。
// 支持同一用户 × 同一角色多会话（总方案决策 9）；删除是软删（本轮决策 4）。
//
// 所有读写都带 user_id 过滤：ownership 校验落在仓库层，M3b 不需要先查一次再判归属。

import type { ChatMessage, ChatSession } from '@miniapp/shared';
import { getSupabaseClient } from '../../lib/supabase.js';
import { clampLimit, toOpeningMessage } from './ConversationHistoryRepository.js';
import { ConversationRepositoryError } from './conversation-errors.js';

const MAX_TITLE_LENGTH = 60;
const DEFAULT_SESSION_TITLE = '新的对话';

/** PostgREST 把「列不存在」透传成 Postgres 的 42703 */
function isMissingPinnedColumn(error: { code?: string; message?: string }): boolean {
  return error.code === '42703' || Boolean(error.message?.includes('pinned_at'));
}

export interface ChatSessionRow {
  id: string;
  user_id: string;
  character_id: string;
  title: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  message_count: number;
  pinned_at: string | null;
  context_window_start_turn: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListSessionsOptions {
  characterId?: string;
  limit?: number;
  offset?: number;
}

export class ChatSessionRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  /**
   * 078 是否已在目标库执行。迁移不随部署自动执行，后端先上、迁移后跑的窗口里
   * PostgREST 会对不存在的列直接报错。会话列表是「历史聊天」页与角色内「对话记录」
   * 抽屉的唯一数据源，为一个排序字段让它整个 500 不划算，所以读路径探到缺列就降级。
   * 写路径不降级：置顶写失败只影响新功能本身，而且能让「迁移没跑」暴露出来。
   */
  private pinnedColumnMissing = false;

  /**
   * 建会话不写 chat_history：只有用户主动发起的对话才进入历史表。
   * 开场白在 API 中仍作为虚拟 turn 0 返回，首轮生成时保存进 chat_history.history。
   *
   * 已有空会话就复用它。进角色卡就会建会话，而列表按 message_count > 0 过滤，
   * 一句话没发就退出的那些用户看不见也就删不掉——不复用的话，每进出一次角色卡
   * 表里就多一行死行，且永远不会被回收。复用之后同一用户 × 同一角色最多留一行空的。
   * 对调用方而言空会话与新会话不可区分（都只有虚拟开场白），换回去没有可观测差异。
   */
  async createSession(
    userId: string,
    characterId: string
  ): Promise<{ session: ChatSessionRow; messages: ChatMessage[] }> {
    const character = await this.getCharacter(characterId);
    const session =
      (await this.findEmptySession(userId, characterId)) ??
      (await this.insertSession(userId, characterId, character.name));

    return {
      session,
      messages: character.firstMes
        ? [toOpeningMessage(session.id, character.firstMes, session.created_at)]
        : [],
    };
  }

  private async findEmptySession(
    userId: string,
    characterId: string
  ): Promise<ChatSessionRow | null> {
    const { data, error } = await this.db
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .is('deleted_at', null)
      .eq('message_count', 0)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`查询空会话失败：${error.message}`);
    return (data as ChatSessionRow | null) ?? null;
  }

  private async insertSession(
    userId: string,
    characterId: string,
    characterName: string
  ): Promise<ChatSessionRow> {
    const { data, error } = await this.db
      .from('chat_sessions')
      .insert({
        user_id: userId,
        character_id: characterId,
        title: titleFromCharacterName(characterName),
      })
      .select('*')
      .single();

    if (error) throw new Error(`创建会话失败：${error.message}`);
    return data as ChatSessionRow;
  }

  /**
   * 侧边栏会话列表：直读 DB，替代 ST 的 recent 反代（总方案决策 11）。
   *
   * 过滤掉 message_count = 0：进角色卡就会建会话，一句话没发的那些不算历史，
   * 露出来只会让列表堆满「新的对话 / 0 条」。会话本身还在，发出第一句后自动归位。
   * total 也走同一条 where，否则分页总数会把这些隐藏会话算进去。
   */
  async listSessions(
    userId: string,
    options: ListSessionsOptions = {}
  ): Promise<{ sessions: ChatSessionRow[]; total: number }> {
    const limit = clampLimit(options.limit, 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const run = async (withPinned: boolean) => {
      let query = this.db
        .from('chat_sessions')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .is('deleted_at', null)
        .gt('message_count', 0);

      if (options.characterId) {
        query = query.eq('character_id', options.characterId);
      }
      if (withPinned) {
        query = query.order('pinned_at', { ascending: false, nullsFirst: false });
      }

      return query
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    };

    let result = await run(!this.pinnedColumnMissing);
    if (result.error && isMissingPinnedColumn(result.error)) {
      // 只在第一次探到时降级并记一次；之后直接走无置顶排序的分支，不再白打一次请求
      this.pinnedColumnMissing = true;
      console.warn(
        '[ChatSessionRepository] chat_sessions.pinned_at 不存在，本次按最近活跃排序。请执行迁移 078_chat_session_pinned.sql'
      );
      result = await run(false);
    }

    if (result.error) throw new Error(`查询会话列表失败：${result.error.message}`);
    return { sessions: (result.data ?? []) as ChatSessionRow[], total: result.count ?? 0 };
  }

  /** 带 ownership 校验：他人会话与已软删会话一律当作不存在 */
  async getSession(sessionId: string, userId: string): Promise<ChatSessionRow | null> {
    const { data, error } = await this.db
      .from('chat_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(`查询会话失败：${error.message}`);
    return (data as ChatSessionRow | null) ?? null;
  }

  async requireSession(sessionId: string, userId: string): Promise<ChatSessionRow> {
    const session = await this.getSession(sessionId, userId);
    if (!session) {
      throw new ConversationRepositoryError('session_not_found', `会话不存在：${sessionId}`);
    }
    return session;
  }

  /**
   * 重命名与置顶合到一次写入：两者都是「改会话属性」，分成两个方法会让同时改动的
   * 请求跑两趟 UPDATE，也让 updated_at 出现两次跳变。
   * patch 里没出现的键一律不动——title 的 null 是「恢复为当前角色名」，不能兼任「不改」。
   */
  async updateSession(
    sessionId: string,
    userId: string,
    patch: { title?: string | null; pinned?: boolean }
  ): Promise<ChatSessionRow> {
    const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('title' in patch) {
      const normalized = normalizeTitle(patch.title ?? null);
      const session = await this.requireSession(sessionId, userId);
      changes.title =
        normalized ?? titleFromCharacterName((await this.getCharacter(session.character_id)).name);
    }
    if (patch.pinned !== undefined) {
      changes.pinned_at = patch.pinned ? new Date().toISOString() : null;
    }

    const { data, error } = await this.db
      .from('chat_sessions')
      .update(changes)
      .eq('id', sessionId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`更新会话失败：${error.message}`);
    if (!data) {
      throw new ConversationRepositoryError('session_not_found', `会话不存在：${sessionId}`);
    }
    return data as ChatSessionRow;
  }

  /** 软删（本轮决策 4）：不再出现在列表，chat_history 的关联行仍可查 */
  async softDelete(sessionId: string, userId: string): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('chat_sessions')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', sessionId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`删除会话失败：${error.message}`);
    if (!data) {
      throw new ConversationRepositoryError('session_not_found', `会话不存在：${sessionId}`);
    }
  }

  async getCharacterFirstMes(characterId: string): Promise<string> {
    return (await this.getCharacter(characterId)).firstMes;
  }

  private async getCharacter(characterId: string): Promise<{ name: string; firstMes: string }> {
    const { data, error } = await this.db
      .from('characters')
      .select('id, name, first_mes')
      .eq('id', characterId)
      .maybeSingle();

    if (error) throw new Error(`查询角色卡失败：${error.message}`);
    if (!data) {
      throw new ConversationRepositoryError('character_not_found', `角色卡不存在：${characterId}`);
    }
    const row = data as { name: string | null; first_mes: string | null };
    return {
      name: (row.name ?? '').trim(),
      firstMes: (row.first_mes ?? '').trim(),
    };
  }
}

export function toChatSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    character_id: row.character_id,
    title: row.title,
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    message_count: row.message_count,
    // 迁移 078 未执行时行里没有这一列，契约仍要给出 null 而不是 undefined
    pinned_at: row.pinned_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function titleFromCharacterName(name: string): string {
  return normalizeTitle(name) ?? DEFAULT_SESSION_TITLE;
}

function normalizeTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null;
}
