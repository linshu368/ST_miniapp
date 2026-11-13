// 对话页的「整理」操作：用户分组（文件夹）、标签栏汇总、按角色归拢、批量移动/置顶/删除。
//
// 存储见 migration 20261113_chat_folders.sql。所有读写都带 user_id：分组归属由复合 FK
// (user_id, folder_id) 在数据库层兜底，这里不必先查一次分组再写会话。

import {
  CHAT_FOLDER_LIMIT,
  type ChatFolder,
  type ChatFolderErrorCode,
  type ChatFolderSummary,
  type ConversationBatchAction,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import type { ChatSessionRow } from './ChatSessionRepository.js';

const RPC_TIMEOUT_MS = 3_000;

export class ChatFolderRepositoryError extends Error {
  constructor(
    readonly code: ChatFolderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ChatFolderRepositoryError';
  }
}

interface PostgrestError {
  code?: string;
  message: string;
}

/** 23503 = 外键：分组不存在或不属于本人；23505 = 同名分组 */
export function toFolderError(error: PostgrestError, fallback: string): Error {
  if (error.code === '23503')
    return new ChatFolderRepositoryError('folder_not_found', '分组不存在');
  if (error.code === '23505') {
    return new ChatFolderRepositoryError('folder_name_taken', '已经有同名分组');
  }
  // 42P01/42703/PGRST202：迁移未执行，分组功能整体不可用，不影响原有列表。
  if (error.code === '42P01' || error.code === '42703' || error.code === 'PGRST202') {
    return new ChatFolderRepositoryError('folders_unavailable', '分组功能暂不可用');
  }
  return new Error(`${fallback}：${error.message}`);
}

interface FolderRow {
  id: string;
  name: string;
  created_at: string;
}

export interface SessionGroupRow {
  session: ChatSessionRow;
  session_count: number;
  pinned_at: string | null;
}

export class ChatFolderRepository {
  // 用到时才取连接：路由注册阶段不触发 Supabase 客户端初始化，既有路由测试无需额外 mock。
  private get db() {
    return getDomainDb('experience');
  }

  async summary(userId: string): Promise<ChatFolderSummary> {
    const { data, error } = await this.db
      .rpc('chat_folder_summary', { p_user_id: userId })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw toFolderError(error, '读取分组汇总失败');
    const value = data as ChatFolderSummary | null;
    if (!value || !Array.isArray(value.folders)) throw new Error('分组汇总结果不完整');
    return value;
  }

  async create(userId: string, name: string): Promise<ChatFolder> {
    const { count, error: countError } = await this.db
      .from('chat_folders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (countError) throw toFolderError(countError, '读取分组失败');
    if ((count ?? 0) >= CHAT_FOLDER_LIMIT) {
      throw new ChatFolderRepositoryError('folder_limit', `最多建 ${CHAT_FOLDER_LIMIT} 个分组`);
    }
    const { data, error } = await this.db
      .from('chat_folders')
      .insert({ user_id: userId, name })
      .select('id,name,created_at')
      .single();
    if (error) throw toFolderError(error, '新建分组失败');
    return { ...(data as FolderRow), session_count: 0 };
  }

  async rename(userId: string, folderId: string, name: string): Promise<ChatFolder> {
    const { data, error } = await this.db
      .from('chat_folders')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', folderId)
      .eq('user_id', userId)
      .select('id,name,created_at')
      .maybeSingle();
    if (error) throw toFolderError(error, '重命名分组失败');
    if (!data) throw new ChatFolderRepositoryError('folder_not_found', '分组不存在');
    const { count, error: countError } = await this.db
      .from('chat_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('folder_id', folderId)
      .is('deleted_at', null)
      .gt('message_count', 0);
    if (countError) throw toFolderError(countError, '读取分组数量失败');
    return { ...(data as FolderRow), session_count: count ?? 0 };
  }

  /** 组里的对话由 FK 的 ON DELETE SET NULL (folder_id) 放回未分组 */
  async remove(userId: string, folderId: string): Promise<void> {
    const { data, error } = await this.db
      .from('chat_folders')
      .delete()
      .eq('id', folderId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();
    if (error) throw toFolderError(error, '删除分组失败');
    if (!data) throw new ChatFolderRepositoryError('folder_not_found', '分组不存在');
  }

  async listGroups(
    userId: string,
    options: { folder?: string; limit?: number; offset?: number }
  ): Promise<{ groups: SessionGroupRow[]; total: number }> {
    const { data, error } = await this.db
      .rpc('list_chat_session_groups', {
        p_user_id: userId,
        p_folder_id: options.folder && options.folder !== 'none' ? options.folder : null,
        p_ungrouped: options.folder === 'none',
        p_limit: options.limit ?? 20,
        p_offset: options.offset ?? 0,
      })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) throw toFolderError(error, '读取按角色列表失败');
    const value = data as { groups: SessionGroupRow[]; total: number } | null;
    if (!value || !Array.isArray(value.groups)) throw new Error('按角色列表结果不完整');
    return value;
  }

  /**
   * 一条 UPDATE 处理整批：已删除、一句没发或不属于本人的 id 自然被过滤，返回实际生效条数。
   * 删除与单条删除同口径（软删）；置顶统一用同一个时间戳，批内保持原有相对顺序。
   */
  async batch(
    userId: string,
    sessionIds: string[],
    action: ConversationBatchAction,
    folderId: string | null
  ): Promise<number> {
    const now = new Date().toISOString();
    const changes: Record<string, unknown> =
      action === 'move'
        ? { folder_id: folderId }
        : action === 'pin'
          ? { pinned_at: now }
          : action === 'unpin'
            ? { pinned_at: null }
            : { deleted_at: now };
    changes.updated_at = now;
    const { data, error } = await this.db
      .from('chat_sessions')
      .update(changes)
      .eq('user_id', userId)
      .in('id', sessionIds)
      .is('deleted_at', null)
      .gt('message_count', 0)
      .select('id');
    if (error) throw toFolderError(error, '批量处理对话失败');
    return (data ?? []).length;
  }
}
