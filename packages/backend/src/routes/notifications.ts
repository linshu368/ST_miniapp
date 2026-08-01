import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  type GetNotificationsData,
  type MarkNotificationsReadData,
  type MarkNotificationsReadRequest,
  type NotificationItem,
  type NotificationScope,
  type NotificationUnreadCountData,
} from '@miniapp/shared';
import { getSupabaseClient } from '../lib/supabase.js';
import { parseNotificationScope, selectUnreadIds } from '../lib/notification-scope.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NotificationRow {
  id: string;
  scope: NotificationScope;
  category: NotificationItem['category'];
  title: string;
  body: string;
  published_at: string | null;
  created_at: string;
}

export default async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const query = request.query as { scope?: string; cursor?: string };
    const scope = query.scope === undefined ? 'official' : parseNotificationScope(query.scope);
    if (!scope) return reply.status(400).send(fail('INVALID_SCOPE', '消息分类无效'));

    const user = await getOrCreateDbUser(request.user);
    const db = getSupabaseClient().schema('miniapp');
    let builder = db
      .from('notifications')
      .select('id,scope,category,title,body,published_at,created_at')
      .eq('scope', scope)
      .eq('is_published', true)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true })
      .order(scope === 'official' ? 'published_at' : 'created_at', { ascending: false })
      .limit(21);
    builder = scope === 'official' ? builder.is('user_id', null) : builder.eq('user_id', user.id);
    if (query.cursor) builder = builder.lt('created_at', query.cursor);

    const { data, error } = await builder;
    if (error) throw new Error(`读取消息失败：${error.message}`);
    const rows = (data ?? []) as NotificationRow[];
    const page = rows.slice(0, 20);
    const readIds = await listReadIds(
      user.id,
      page.map((item) => item.id)
    );
    const notifications = page.map((item) => mapNotification(item, readIds.has(item.id)));
    return reply.send(
      ok<GetNotificationsData>({
        notifications,
        next_cursor: rows.length > 20 ? (page.at(-1)?.created_at ?? null) : null,
      })
    );
  });

  app.get(
    '/api/notifications/unread-count',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const user = await getOrCreateDbUser(request.user);
      const [official, personal] = await Promise.all([
        countUnread(user.id, 'official'),
        countUnread(user.id, 'personal'),
      ]);
      return reply.send(
        ok<NotificationUnreadCountData>({ official, personal, total: official + personal })
      );
    }
  );

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
      const ids = Array.isArray(body.ids)
        ? [...new Set(body.ids.filter((id) => UUID_RE.test(id)))]
        : [];
      if (!scope && ids.length === 0) {
        return reply.status(400).send(fail('INVALID_READ_TARGET', '请选择要标记的消息'));
      }

      const user = await getOrCreateDbUser(request.user);
      const visibleIds = await listVisibleIds(user.id, scope, ids);
      if (visibleIds.length === 0) return reply.send(ok<MarkNotificationsReadData>({ marked: 0 }));
      const { error } = await getSupabaseClient()
        .schema('miniapp')
        .from('notification_reads')
        .upsert(
          visibleIds.map((notificationId) => ({
            notification_id: notificationId,
            user_id: user.id,
            read_at: new Date().toISOString(),
          })),
          { onConflict: 'notification_id,user_id' }
        );
      if (error) throw new Error(`标记消息已读失败：${error.message}`);
      return reply.send(ok<MarkNotificationsReadData>({ marked: visibleIds.length }));
    }
  );
}

async function listReadIds(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await getSupabaseClient()
    .schema('miniapp')
    .from('notification_reads')
    .select('notification_id')
    .eq('user_id', userId)
    .in('notification_id', ids);
  if (error) throw new Error(`读取消息状态失败：${error.message}`);
  return new Set((data ?? []).map((row) => String(row.notification_id)));
}

async function countUnread(userId: string, scope: NotificationScope): Promise<number> {
  const db = getSupabaseClient().schema('miniapp');
  let query = db
    .from('notifications')
    .select('id')
    .eq('scope', scope)
    .eq('is_published', true)
    .is('deleted_at', null);
  query = scope === 'official' ? query.is('user_id', null) : query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error(`读取未读消息失败：${error.message}`);
  const ids = (data ?? []).map((row) => String(row.id));
  return selectUnreadIds(ids, await listReadIds(userId, ids)).length;
}

async function listVisibleIds(
  userId: string,
  scope: NotificationScope | undefined,
  ids: string[]
): Promise<string[]> {
  const db = getSupabaseClient().schema('miniapp');
  let query = db
    .from('notifications')
    .select('id,scope,user_id')
    .eq('is_published', true)
    .is('deleted_at', null);
  if (scope) query = query.eq('scope', scope);
  if (ids.length > 0) query = query.in('id', ids);
  const { data, error } = await query;
  if (error) throw new Error(`读取消息失败：${error.message}`);
  return (data ?? [])
    .filter((row) => row.scope === 'official' || row.user_id === userId)
    .map((row) => String(row.id));
}

function mapNotification(row: NotificationRow, isRead: boolean): NotificationItem {
  return {
    ...row,
    published_at: row.published_at ?? row.created_at,
    is_read: isRead,
  };
}
