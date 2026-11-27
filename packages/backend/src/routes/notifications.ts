import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  fail,
  isOutsideNotificationUnreadWindow,
  NOTIFICATION_UNREAD_WINDOW_MS,
  ok,
  VipExpiryNotificationMetadataSchema,
  CharacterWishNotificationMetadataSchema,
  NotificationKindSchema,
  type GetNotificationDetailData,
  type GetNotificationsData,
  type MarkNotificationsReadData,
  type MarkNotificationsReadRequest,
  type NotificationItem,
  type NotificationScope,
  type NotificationUnreadCountData,
} from '@miniapp/shared';
import { getDomainDb } from '../lib/supabase.js';
import {
  isNotificationVisibleToUser,
  parseNotificationScope,
  selectUnreadIds,
} from '../lib/notification-scope.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_ID_LIMIT = 20;
const LIST_LIMIT = 50;
const NOTIFICATION_COLUMNS =
  'id,scope,category,title,body,published_at,created_at,user_id,kind,action_path,metadata';

interface NotificationRow {
  id: string;
  scope: NotificationScope;
  category: NotificationItem['category'];
  title: string;
  body: string;
  published_at: string | null;
  created_at: string;
  user_id: string | null;
  kind: string | null;
  action_path: string | null;
  metadata: unknown;
}

export default async function notificationRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/notifications', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const query = request.query as { scope?: string; cursor?: string };
    const scope = query.scope === undefined ? 'official' : parseNotificationScope(query.scope);
    if (!scope) return reply.status(400).send(fail('INVALID_SCOPE', '消息分类无效'));

    const user = await getOrCreateDbUser(request.user);
    const db = getDomainDb('features');
    let builder = db
      .from('notifications')
      .select(NOTIFICATION_COLUMNS)
      .eq('scope', scope)
      .eq('is_published', true)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order(scope === 'official' ? 'published_at' : 'created_at', { ascending: false })
      .limit(LIST_LIMIT + 1);
    builder =
      scope === 'official'
        ? builder.or(`user_id.is.null,user_id.eq.${user.id}`)
        : builder.eq('user_id', user.id);
    if (query.cursor) builder = builder.lt('created_at', query.cursor);

    const { data, error } = await builder;
    if (error) {
      request.log.error({ err: error, event: 'notification.list_failed' }, '读取消息失败');
      throw new Error('读取消息失败');
    }
    const rows = (data ?? []) as NotificationRow[];
    const page = rows.slice(0, LIST_LIMIT);
    const readIds = await listReadIds(
      user.id,
      page.map((item) => item.id)
    );
    const now = Date.now();
    const notifications = page.map((item) => mapNotification(item, isRead(item, readIds, now)));
    return reply.send(
      ok<GetNotificationsData>({
        notifications,
        next_cursor: rows.length > LIST_LIMIT ? (page.at(-1)?.created_at ?? null) : null,
      })
    );
  });

  // @frontend-ready: true
  app.get(
    '/api/notifications/unread-count',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const user = await getOrCreateDbUser(request.user);
      const [official, personal] = await Promise.all([
        listUnreadIds(user.id, 'official').then((ids) => ids.length),
        listUnreadIds(user.id, 'personal').then((ids) => ids.length),
      ]);
      return reply.send(
        ok<NotificationUnreadCountData>({ official, personal, total: official + personal })
      );
    }
  );

  // @frontend-ready: true
  // 打开列表不能批量已读。写入目标只有两种：显式 ids，或玩家点「全部已读」时的 scope + all。
  // 重复调用只保持已读。
  app.post(
    '/api/notifications/read',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const body = (request.body ?? {}) as MarkNotificationsReadRequest;
      let scope: NotificationScope | undefined;
      if (body.scope !== undefined) {
        const parsed = parseNotificationScope(body.scope);
        if (!parsed) return reply.status(400).send(fail('INVALID_SCOPE', '消息分类无效'));
        scope = parsed;
      }
      if (body.all !== undefined) {
        if (body.all !== true || !scope || body.ids !== undefined) {
          return reply.status(400).send(fail('INVALID_READ_TARGET', '请选择要标记的消息'));
        }
        const user = await getOrCreateDbUser(request.user);
        const unreadIds = await listUnreadIds(user.id, scope);
        await upsertReads(request, user.id, unreadIds);
        request.log.info(
          { event: 'notification.read_all', scope, marked: unreadIds.length },
          '全部标记已读'
        );
        return reply.send(ok<MarkNotificationsReadData>({ marked: unreadIds.length }));
      }
      const ids = normalizeReadIds(body.ids);
      if (!ids) return reply.status(400).send(fail('INVALID_READ_TARGET', '请选择要标记的消息'));

      const user = await getOrCreateDbUser(request.user);
      const visibleIds = await listVisibleIds(user.id, scope, ids);
      await upsertReads(request, user.id, visibleIds);
      return reply.send(ok<MarkNotificationsReadData>({ marked: visibleIds.length }));
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/notifications/:id',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) {
        return reply.status(400).send(fail('INVALID_NOTIFICATION_ID', '消息不存在'));
      }

      const user = await getOrCreateDbUser(request.user);
      const { data, error } = await getDomainDb('features')
        .from('notifications')
        .select(NOTIFICATION_COLUMNS)
        .eq('id', id)
        .eq('is_published', true)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) {
        request.log.error({ err: error, event: 'notification.detail_failed' }, '读取消息详情失败');
        throw new Error('读取消息详情失败');
      }
      const row = data as NotificationRow | null;
      if (!row || !isNotificationVisibleToUser(row, user.id)) {
        return reply.status(404).send(fail('NOTIFICATION_NOT_FOUND', '消息不存在'));
      }
      const readIds = await listReadIds(user.id, [row.id]);
      return reply.send(
        ok<GetNotificationDetailData>({
          notification: mapNotification(row, isRead(row, readIds, Date.now())),
        })
      );
    }
  );
}

function normalizeReadIds(ids: MarkNotificationsReadRequest['ids']): string[] | null {
  if (!Array.isArray(ids)) return null;
  const unique = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (unique.length === 0 || unique.length > READ_ID_LIMIT) return null;
  return unique;
}

async function listReadIds(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await getDomainDb('features')
    .from('notification_reads')
    .select('notification_id')
    .eq('user_id', userId)
    .in('notification_id', ids);
  if (error) throw new Error('读取消息状态失败');
  return new Set((data ?? []).map((row) => String(row.notification_id)));
}

function isRead(
  row: Pick<NotificationRow, 'id' | 'published_at' | 'created_at'>,
  readIds: Set<string>,
  nowMs: number
): boolean {
  return (
    readIds.has(row.id) ||
    isOutsideNotificationUnreadWindow(row.published_at ?? row.created_at, nowMs)
  );
}

/** 已发布的行都有 published_at（只有草稿为空），所以窗口直接按它过滤。 */
async function listUnreadIds(userId: string, scope: NotificationScope): Promise<string[]> {
  const db = getDomainDb('features');
  let query = db
    .from('notifications')
    .select('id')
    .eq('scope', scope)
    .eq('is_published', true)
    .is('deleted_at', null)
    .gte('published_at', new Date(Date.now() - NOTIFICATION_UNREAD_WINDOW_MS).toISOString());
  query =
    scope === 'official'
      ? query.or(`user_id.is.null,user_id.eq.${userId}`)
      : query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error('读取未读消息失败');
  const ids = (data ?? []).map((row) => String(row.id));
  return selectUnreadIds(ids, await listReadIds(userId, ids));
}

async function upsertReads(
  request: FastifyRequest,
  userId: string,
  notificationIds: string[]
): Promise<void> {
  if (notificationIds.length === 0) return;
  const readAt = new Date().toISOString();
  const { error } = await getDomainDb('features')
    .from('notification_reads')
    .upsert(
      notificationIds.map((notificationId) => ({
        notification_id: notificationId,
        user_id: userId,
        read_at: readAt,
      })),
      { onConflict: 'notification_id,user_id' }
    );
  if (error) {
    request.log.error({ err: error, event: 'notification.read_failed' }, '标记消息已读失败');
    throw new Error('标记消息已读失败');
  }
}

async function listVisibleIds(
  userId: string,
  scope: NotificationScope | undefined,
  ids: string[]
): Promise<string[]> {
  const db = getDomainDb('features');
  let query = db
    .from('notifications')
    .select('id,scope,user_id')
    .eq('is_published', true)
    .is('deleted_at', null)
    .in('id', ids);
  if (scope) query = query.eq('scope', scope);
  const { data, error } = await query;
  if (error) throw new Error('读取消息失败');
  return (data ?? [])
    .filter((row) =>
      isNotificationVisibleToUser(
        { scope: row.scope as NotificationScope, user_id: row.user_id as string | null },
        userId
      )
    )
    .map((row) => String(row.id));
}

function mapNotification(row: NotificationRow, isRead: boolean): NotificationItem {
  const parsedKind = NotificationKindSchema.safeParse(row.kind);
  const kind = parsedKind.success ? parsedKind.data : null;
  const metadata = (
    kind === 'character_wish_response'
      ? CharacterWishNotificationMetadataSchema
      : VipExpiryNotificationMetadataSchema
  ).safeParse(row.metadata);
  return {
    id: row.id,
    scope: row.scope,
    category: row.category,
    title: row.title,
    body: row.body,
    published_at: row.published_at ?? row.created_at,
    created_at: row.created_at,
    is_read: isRead,
    kind,
    action_path: typeof row.action_path === 'string' ? row.action_path : null,
    metadata: metadata.success ? metadata.data : null,
  };
}
