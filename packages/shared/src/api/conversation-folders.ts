/**
 * 对话页分组（文件夹）、按角色归拢与批量管理的契约。
 * 存储：experience.chat_folders + experience.chat_sessions.folder_id（migration 20261113_chat_folders.sql）。
 */
import { z } from 'zod';
import type { ChatSession } from './conversations';

export const CHAT_FOLDER_NAME_MAX = 12;
export const CHAT_FOLDER_LIMIT = 20;
export const CONVERSATION_BATCH_LIMIT = 100;

export interface ChatFolder {
  id: string;
  name: string;
  /** 口径与列表一致：未删除且至少发过一句 */
  session_count: number;
  created_at: string;
}

export interface ChatFolderSummary {
  all: number;
  ungrouped: number;
  /** 按创建先后 */
  folders: ChatFolder[];
}

export type ChatFolderErrorCode =
  | 'folder_not_found'
  /** 同一用户下分组名重复 */
  | 'folder_name_taken'
  /** 超过 CHAT_FOLDER_LIMIT 个 */
  | 'folder_limit'
  /** 迁移未执行或汇总暂不可用 */
  | 'folders_unavailable';

/** trim 后 1–12 字；前后空白不计入 */
export const ChatFolderNameSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(CHAT_FOLDER_NAME_MAX));

// ==== POST /api/v1/conversation-folders ====
export const CreateChatFolderRequestSchema = z.object({ name: ChatFolderNameSchema }).strict();
export type CreateChatFolderRequest = z.input<typeof CreateChatFolderRequestSchema>;
export interface CreateChatFolderData {
  folder: ChatFolder;
}

// ==== PATCH /api/v1/conversation-folders/:id ====
export const RenameChatFolderRequestSchema = CreateChatFolderRequestSchema;
export type RenameChatFolderRequest = CreateChatFolderRequest;
export type RenameChatFolderData = CreateChatFolderData;

// ==== DELETE /api/v1/conversation-folders/:id ====
/** 删分组不删对话：组里的对话回到未分组 */
export interface DeleteChatFolderData {
  id: string;
}

// ==== POST /api/v1/conversations/batch ====
export const CONVERSATION_BATCH_ACTIONS = ['move', 'pin', 'unpin', 'delete'] as const;
export type ConversationBatchAction = (typeof CONVERSATION_BATCH_ACTIONS)[number];

export const ConversationBatchRequestSchema = z
  .object({
    session_ids: z.array(z.string().uuid()).min(1).max(CONVERSATION_BATCH_LIMIT),
    action: z.enum(CONVERSATION_BATCH_ACTIONS),
    /** 仅 move 使用；null = 移出分组 */
    folder_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => value.action !== 'move' || value.folder_id !== undefined, {
    message: 'move 需要 folder_id（移出分组传 null）',
    path: ['folder_id'],
  });
export type ConversationBatchRequest = z.infer<typeof ConversationBatchRequestSchema>;
export interface ConversationBatchData {
  /** 实际生效的条数：已删除或不属于本人的 id 会被跳过 */
  updated: number;
}

// ==== GET /api/v1/conversations/groups ====
export interface ConversationGroup {
  /** 该角色最新的一段：点归拢行接着聊的就是它 */
  session: ChatSession;
  session_count: number;
  /** 整组置顶时间：角色里任意一段置顶即整组置顶（取最近一次）；null = 未置顶 */
  pinned_at: string | null;
}

export interface ListConversationGroupsData {
  groups: ConversationGroup[];
  /** 角色数 */
  total: number;
  folder_summary?: ChatFolderSummary;
}
