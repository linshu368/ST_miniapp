/**
 * 对话页的整理接口：分组（文件夹）增改删、按角色归拢列表、批量移动/置顶/删除。
 * 数据与归属见 migration 20261113_chat_folders.sql；鉴权与 ownership 同其他对话路由。
 */
import {
  CONVERSATION_QUICK_FILTERS,
  ConversationBatchRequestSchema,
  CreateChatFolderRequestSchema,
  RenameChatFolderRequestSchema,
  fail,
  ok,
  type ChatFolderErrorCode,
  type ChatFolderSummary,
  type ConversationBatchData,
  type ConversationQuickFilter,
  type CreateChatFolderData,
  type DeleteChatFolderData,
  type ListConversationGroupsData,
  type RenameChatFolderData,
} from '@miniapp/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { applyUserPlaceholderToSession } from '../features/conversations/index.js';
import {
  ChatFolderRepositoryError,
  type ChatFolderRepository,
} from '../infrastructure/repositories/ChatFolderRepository.js';
import { toChatSession } from '../infrastructure/repositories/ChatSessionRepository.js';
import { requestLogger } from '../lib/logger.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import {
  UUID_PATTERN,
  parsePositiveInt,
  type ConversationRouteRepositories,
} from './conversation-route-shared.js';

const SEARCH_MAX = 30;

const FOLDER_ERROR_STATUS: Record<ChatFolderErrorCode, number> = {
  folder_not_found: 404,
  folder_name_taken: 409,
  folder_limit: 409,
  folders_unavailable: 503,
};

export function sendChatFolderError(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof ChatFolderRepositoryError)) return false;
  void reply.status(FOLDER_ERROR_STATUS[error.code]).send(fail(error.code, error.message));
  return true;
}

/** folder 只认 uuid / none；q 去空白后截到 30 字，空串视为不搜；非法值返回 null（400）。 */
export function parseListFilters(
  query: Record<string, string | undefined>
): { folder?: string; query?: string; quick?: ConversationQuickFilter } | null {
  const folder = query.folder;
  if (folder !== undefined && folder !== 'none' && !UUID_PATTERN.test(folder)) return null;
  const quick = query.quick;
  if (
    quick !== undefined &&
    !CONVERSATION_QUICK_FILTERS.includes(quick as ConversationQuickFilter)
  ) {
    return null;
  }
  const search = query.q?.trim().slice(0, SEARCH_MAX);
  return {
    ...(folder ? { folder } : {}),
    ...(search ? { query: search } : {}),
    ...(quick ? { quick: quick as ConversationQuickFilter } : {}),
  };
}

/** 汇总只服务标签栏：失败时列表照常返回，前端隐藏分组入口。 */
export async function readFolderSummary(
  folders: ChatFolderRepository,
  userId: string,
  log: FastifyBaseLogger
): Promise<ChatFolderSummary | null> {
  try {
    return await folders.summary(userId);
  } catch (err) {
    requestLogger(log, 'conversations').sys.warn(
      { event: 'conversation.folder.summary_failed', err, userId },
      '读取分组汇总失败，列表不带汇总'
    );
    return null;
  }
}

export function registerConversationGroups(
  app: FastifyInstance,
  { settings, folders }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.get(
    '/api/v1/conversations/groups',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const query = request.query as Record<string, string | undefined>;
      const filters = parseListFilters({ folder: query.folder });
      if (!filters) return reply.status(400).send(fail('BAD_REQUEST', '筛选条件无效'));

      const dbUser = await getOrCreateDbUser(request.user);
      const offset = parsePositiveInt(query.offset);
      try {
        const [{ groups, total }, displayName, folderSummary] = await Promise.all([
          folders.listGroups(dbUser.id, {
            folder: filters.folder,
            limit: Math.min(parsePositiveInt(query.limit) ?? 20, 100),
            offset,
          }),
          settings.getDisplayName(dbUser.id),
          query.summary === '1' && !offset
            ? readFolderSummary(folders, dbUser.id, request.log)
            : null,
        ]);
        return reply.send(
          ok<ListConversationGroupsData>({
            groups: groups.map((group) => ({
              session: applyUserPlaceholderToSession(toChatSession(group.session), displayName),
              session_count: group.session_count,
              pinned_at: group.pinned_at ?? null,
            })),
            total,
            ...(folderSummary ? { folder_summary: folderSummary } : {}),
          })
        );
      } catch (error) {
        if (sendChatFolderError(reply, error)) return;
        throw error;
      }
    }
  );
}

export function registerConversationBatch(
  app: FastifyInstance,
  { folders }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/batch',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const parsed = ConversationBatchRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send(fail('BAD_REQUEST', '批量操作参数无效'));

      const log = requestLogger(request.log, 'conversations');
      const dbUser = await getOrCreateDbUser(request.user);
      const { session_ids: ids, action, folder_id: folderId } = parsed.data;
      const startedAt = Date.now();
      try {
        const updated = await folders.batch(dbUser.id, [...new Set(ids)], action, folderId ?? null);
        log.biz.info(
          {
            event: 'conversation.batch.applied',
            userId: dbUser.id,
            action,
            requested: ids.length,
            updated,
            durationMs: Date.now() - startedAt,
          },
          '批量整理对话'
        );
        return reply.send(ok<ConversationBatchData>({ updated }));
      } catch (error) {
        if (sendChatFolderError(reply, error)) return;
        log.sys.error(
          { event: 'conversation.batch.failed', err: error, userId: dbUser.id, action },
          '批量整理对话失败'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', '批量处理失败，请稍后再试'));
      }
    }
  );
}

function folderIdParam(request: { params: unknown }): string | null {
  const id = (request.params as { id?: string }).id;
  return id && UUID_PATTERN.test(id) ? id : null;
}

export function registerChatFolders(
  app: FastifyInstance,
  { folders }: ConversationRouteRepositories
) {
  // @frontend-ready: true
  app.post(
    '/api/v1/conversation-folders',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const parsed = CreateChatFolderRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply.status(400).send(fail('BAD_REQUEST', '分组名需要 1–12 个字'));
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const folder = await folders.create(dbUser.id, parsed.data.name);
        requestLogger(request.log, 'conversations').biz.info(
          { event: 'conversation.folder.created', userId: dbUser.id, folderId: folder.id },
          '新建对话分组'
        );
        return reply.send(ok<CreateChatFolderData>({ folder }));
      } catch (error) {
        if (sendChatFolderError(reply, error)) return;
        throw error;
      }
    }
  );

  // @frontend-ready: true
  app.patch(
    '/api/v1/conversation-folders/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const folderId = folderIdParam(request);
      const parsed = RenameChatFolderRequestSchema.safeParse(request.body ?? {});
      if (!folderId || !parsed.success) {
        return reply.status(400).send(fail('BAD_REQUEST', '分组名需要 1–12 个字'));
      }
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        const folder = await folders.rename(dbUser.id, folderId, parsed.data.name);
        return reply.send(ok<RenameChatFolderData>({ folder }));
      } catch (error) {
        if (sendChatFolderError(reply, error)) return;
        throw error;
      }
    }
  );

  // @frontend-ready: true
  app.delete(
    '/api/v1/conversation-folders/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const folderId = folderIdParam(request);
      if (!folderId) return reply.status(400).send(fail('BAD_REQUEST', '分组 ID 无效'));
      const dbUser = await getOrCreateDbUser(request.user);
      try {
        await folders.remove(dbUser.id, folderId);
        requestLogger(request.log, 'conversations').biz.info(
          { event: 'conversation.folder.deleted', userId: dbUser.id, folderId },
          '删除对话分组（对话回到未分组）'
        );
        return reply.send(ok<DeleteChatFolderData>({ id: folderId }));
      } catch (error) {
        if (sendChatFolderError(reply, error)) return;
        throw error;
      }
    }
  );
}
