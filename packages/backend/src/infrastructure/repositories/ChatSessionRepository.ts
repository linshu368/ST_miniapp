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

export interface ChatSessionRow {
  id: string;
  user_id: string;
  character_id: string;
  title: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  message_count: number;
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
   * 建会话不写 chat_history：只有用户主动发起的对话才进入历史表。
   * 开场白在 API 中仍作为虚拟 turn 0 返回，首轮生成时保存进 chat_history.history。
   */
  async createSession(
    userId: string,
    characterId: string
  ): Promise<{ session: ChatSessionRow; messages: ChatMessage[] }> {
    const firstMes = await this.getCharacterFirstMes(characterId);

    const { data, error } = await this.db
      .from('chat_sessions')
      .insert({ user_id: userId, character_id: characterId })
      .select('*')
      .single();

    if (error) throw new Error(`创建会话失败：${error.message}`);
    const session = data as ChatSessionRow;
    return {
      session,
      messages: firstMes ? [toOpeningMessage(session.id, firstMes, session.created_at)] : [],
    };
  }

  /** 侧边栏会话列表：直读 DB，替代 ST 的 recent 反代（总方案决策 11） */
  async listSessions(
    userId: string,
    options: ListSessionsOptions = {}
  ): Promise<{ sessions: ChatSessionRow[]; total: number }> {
    const limit = clampLimit(options.limit, 20, 100);
    const offset = Math.max(options.offset ?? 0, 0);

    let query = this.db
      .from('chat_sessions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (options.characterId) {
      query = query.eq('character_id', options.characterId);
    }

    const { data, error, count } = await query
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`查询会话列表失败：${error.message}`);
    return { sessions: (data ?? []) as ChatSessionRow[], total: count ?? 0 };
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

  /** title 传 null = 清空为自动命名，由前端按首条用户消息截断显示 */
  async rename(sessionId: string, userId: string, title: string | null): Promise<ChatSessionRow> {
    const normalized = normalizeTitle(title);
    const { data, error } = await this.db
      .from('chat_sessions')
      .update({ title: normalized, updated_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`重命名会话失败：${error.message}`);
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
    const { data, error } = await this.db
      .from('characters')
      .select('id, first_mes')
      .eq('id', characterId)
      .maybeSingle();

    if (error) throw new Error(`查询角色卡失败：${error.message}`);
    if (!data) {
      throw new ConversationRepositoryError('character_not_found', `角色卡不存在：${characterId}`);
    }
    return ((data as { first_mes: string | null }).first_mes ?? '').trim();
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null;
}
