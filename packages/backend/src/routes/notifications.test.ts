import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = '00000000-0000-4000-8000-000000000099';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const MINE = '00000000-0000-4000-8000-0000000000a1';
const THEIRS = '00000000-0000-4000-8000-0000000000a2';
const BROADCAST = '00000000-0000-4000-8000-0000000000a3';
const HIDDEN = '00000000-0000-4000-8000-0000000000a4';
const DELETED = '00000000-0000-4000-8000-0000000000a5';

interface NotificationFixture {
  id: string;
  scope: 'official' | 'personal';
  category: 'announcement' | 'activity' | 'system' | 'interaction';
  title: string;
  body: string;
  published_at: string | null;
  created_at: string;
  user_id: string | null;
  kind: string | null;
  action_path: string | null;
  metadata: unknown;
  is_published: boolean;
  deleted_at: string | null;
  sort_order: number;
}

interface ReadFixture {
  notification_id: string;
  user_id: string;
  read_at: string;
}

const notifications: NotificationFixture[] = [];
const reads: ReadFixture[] = [];

function matches(row: NotificationFixture, filters: Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.column as keyof NotificationFixture] === filter.value;
    if (filter.op === 'is') return row[filter.column as keyof NotificationFixture] == filter.value;
    if (filter.op === 'in')
      return (filter.value as string[]).includes(
        String(row[filter.column as keyof NotificationFixture])
      );
    if (filter.op === 'lt') return String(row.created_at) < String(filter.value);
    if (filter.op === 'or') {
      return String(filter.value)
        .split(',')
        .some((part) => {
          if (part === 'user_id.is.null') return row.user_id === null;
          if (part.startsWith('user_id.eq.'))
            return row.user_id === part.slice('user_id.eq.'.length);
          return false;
        });
    }
    return true;
  });
}

interface Filter {
  op: string;
  column?: string;
  value?: unknown;
}

function query(table: 'notifications' | 'notification_reads') {
  const state: {
    filters: Filter[];
    action: 'select' | 'upsert';
    rows: Array<Record<string, unknown>>;
    single: boolean;
    limit: number | null;
  } = { filters: [], action: 'select', rows: [], single: false, limit: null };

  const execute = () => {
    if (table === 'notification_reads' && state.action === 'upsert') {
      for (const row of state.rows) {
        const exists = reads.some(
          (item) => item.notification_id === row.notification_id && item.user_id === row.user_id
        );
        if (!exists) {
          reads.push({
            notification_id: String(row.notification_id),
            user_id: String(row.user_id),
            read_at: String(row.read_at),
          });
        }
      }
      return { data: null, error: null };
    }
    if (table === 'notification_reads') {
      const userFilter = state.filters.find(
        (filter) => filter.op === 'eq' && filter.column === 'user_id'
      );
      const idFilter = state.filters.find(
        (filter) => filter.op === 'in' && filter.column === 'notification_id'
      );
      const data = reads.filter((row) => {
        if (userFilter && row.user_id !== userFilter.value) return false;
        if (idFilter && !(idFilter.value as string[]).includes(row.notification_id)) return false;
        return true;
      });
      return { data, error: null };
    }
    let rows = notifications.filter((row) =>
      matches(
        row,
        state.filters.filter((filter) => filter.op !== 'limit')
      )
    );
    rows = [...rows].sort((left, right) => right.created_at.localeCompare(left.created_at));
    if (state.limit !== null) rows = rows.slice(0, state.limit);
    if (state.single) {
      if (rows.length > 1) return { data: null, error: { message: 'multiple' } };
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      state.filters.push({ op: 'eq', column, value });
      return builder;
    },
    is: (column: string, value: unknown) => {
      state.filters.push({ op: 'is', column, value });
      return builder;
    },
    in: (column: string, value: unknown) => {
      state.filters.push({ op: 'in', column, value });
      return builder;
    },
    or: (value: string) => {
      state.filters.push({ op: 'or', value });
      return builder;
    },
    order: () => builder,
    limit: (value: number) => {
      state.limit = value;
      return builder;
    },
    lt: (column: string, value: unknown) => {
      state.filters.push({ op: 'lt', column, value });
      return builder;
    },
    upsert: (rows: Array<Record<string, unknown>>) => {
      state.action = 'upsert';
      state.rows = rows;
      return builder;
    },
    maybeSingle: () => {
      state.single = true;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject),
  };
  return builder;
}

vi.mock('../lib/supabase.js', () => ({
  getSupabaseClient: () => ({ schema: () => ({}) }),
  getDomainDb: () => ({
    from: (table: 'notifications' | 'notification_reads') => query(table),
  }),
}));

vi.mock('../lib/user.js', () => ({
  getOrCreateDbUser: vi.fn(async () => ({ id: ME })),
}));

function seed(): void {
  notifications.splice(0, notifications.length);
  reads.splice(0, reads.length);
  notifications.push(
    {
      id: MINE,
      scope: 'official',
      category: 'system',
      title: 'VIP 即将到期',
      body: '您的 VIP 将于 2026-09-26（北京时间）到期。',
      published_at: '2026-09-23T02:00:00.000Z',
      created_at: '2026-09-23T02:00:00.000Z',
      user_id: ME,
      kind: 'vip_expiry',
      action_path: '/vip',
      metadata: {
        reminder_window: 'expiring_soon',
        observed_valid_until: '2026-09-26T07:00:00.000000Z',
      },
      is_published: true,
      deleted_at: null,
      sort_order: 0,
    },
    {
      id: THEIRS,
      scope: 'official',
      category: 'system',
      title: '别人的 VIP 提醒',
      body: '不该被看到的正文',
      published_at: '2026-09-23T01:00:00.000Z',
      created_at: '2026-09-23T01:00:00.000Z',
      user_id: OTHER,
      kind: 'vip_expiry',
      action_path: '/vip',
      metadata: {
        reminder_window: 'expires_today',
        observed_valid_until: '2026-09-23T07:00:00.000000Z',
      },
      is_published: true,
      deleted_at: null,
      sort_order: 0,
    },
    {
      id: BROADCAST,
      scope: 'official',
      category: 'announcement',
      title: '普通公告',
      body: '全体可见',
      published_at: '2026-09-22T01:00:00.000Z',
      created_at: '2026-09-22T01:00:00.000Z',
      user_id: null,
      kind: null,
      action_path: null,
      metadata: null,
      is_published: true,
      deleted_at: null,
      sort_order: 1,
    },
    {
      id: HIDDEN,
      scope: 'official',
      category: 'announcement',
      title: '未发布公告',
      body: '草稿正文',
      published_at: null,
      created_at: '2026-09-22T03:00:00.000Z',
      user_id: null,
      kind: null,
      action_path: null,
      metadata: null,
      is_published: false,
      deleted_at: null,
      sort_order: 0,
    },
    {
      id: DELETED,
      scope: 'official',
      category: 'announcement',
      title: '已删除公告',
      body: '删除正文',
      published_at: '2026-09-22T04:00:00.000Z',
      created_at: '2026-09-22T04:00:00.000Z',
      user_id: null,
      kind: null,
      action_path: null,
      metadata: null,
      is_published: true,
      deleted_at: '2026-09-22T05:00:00.000Z',
      sort_order: 0,
    }
  );
}

async function buildApp() {
  const { default: notificationRoutes } = await import('./notifications.js');
  const app = Fastify({ logger: false });
  await app.register(notificationRoutes);
  await app.ready();
  return app;
}

describe('notification routes', () => {
  beforeEach(() => {
    seed();
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
  });

  it('requires telegram auth', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '');
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/notifications' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('lists the user own official reminder and ordinary broadcasts without marking them read', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/notifications?scope=official',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: {
          notifications: Array<{
            id: string;
            kind: string | null;
            is_read: boolean;
            title: string;
          }>;
        };
      };
      const ids = body.data.notifications.map((item) => item.id);
      expect(ids).toEqual([MINE, BROADCAST]);
      expect(body.data.notifications[0]).toMatchObject({
        kind: 'vip_expiry',
        action_path: '/vip',
        is_read: false,
        metadata: { reminder_window: 'expiring_soon' },
      });
      expect(body.data.notifications[1]).toMatchObject({
        title: '普通公告',
        kind: null,
        action_path: null,
        metadata: null,
        is_read: false,
      });
      expect(JSON.stringify(body)).not.toContain('别人的 VIP 提醒');
      expect(JSON.stringify(body)).not.toContain('未发布公告');
      expect(JSON.stringify(body)).not.toContain('已删除公告');
      expect(reads).toHaveLength(0);

      const unread = await app.inject({ method: 'GET', url: '/api/notifications/unread-count' });
      expect(unread.json()).toMatchObject({ data: { official: 2, personal: 0, total: 2 } });
    } finally {
      await app.close();
    }
  });

  it('returns the same not-found result for another user, unpublished and deleted messages', async () => {
    const app = await buildApp();
    try {
      for (const id of [THEIRS, HIDDEN, DELETED, '00000000-0000-4000-8000-0000000000ff']) {
        const response = await app.inject({ method: 'GET', url: `/api/notifications/${id}` });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          success: false,
          error: { code: 'NOTIFICATION_NOT_FOUND', message: '消息不存在' },
        });
        expect(response.body).not.toContain('不该被看到的正文');
        expect(response.body).not.toContain('草稿正文');
      }
      const mine = await app.inject({ method: 'GET', url: `/api/notifications/${MINE}` });
      expect(mine.statusCode).toBe(200);
      expect(mine.json()).toMatchObject({
        data: {
          notification: {
            id: MINE,
            is_read: false,
            title: 'VIP 即将到期',
            body: '您的 VIP 将于 2026-09-26（北京时间）到期。',
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('marks only the requested visible id and keeps the count idempotent', async () => {
    const app = await buildApp();
    try {
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        payload: { scope: 'official' },
      });
      expect(blocked.statusCode).toBe(400);
      expect(reads).toHaveLength(0);

      const other = await app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        payload: { ids: [THEIRS, HIDDEN] },
      });
      expect(other.statusCode).toBe(200);
      expect(other.json()).toMatchObject({ data: { marked: 0 } });
      expect(reads).toHaveLength(0);

      const once = await app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        payload: { ids: [MINE] },
      });
      expect(once.json()).toMatchObject({ data: { marked: 1 } });
      const twice = await app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        payload: { ids: [MINE] },
      });
      expect(twice.statusCode).toBe(200);
      expect(twice.json()).toMatchObject({ data: { marked: 1 } });
      expect(reads).toHaveLength(1);

      const unread = await app.inject({ method: 'GET', url: '/api/notifications/unread-count' });
      expect(unread.json()).toMatchObject({ data: { official: 1, total: 1 } });
      const detail = await app.inject({ method: 'GET', url: `/api/notifications/${MINE}` });
      expect(detail.json()).toMatchObject({ data: { notification: { is_read: true } } });
      const list = await app.inject({ method: 'GET', url: '/api/notifications?scope=official' });
      const items = (
        list.json() as { data: { notifications: Array<{ id: string; is_read: boolean }> } }
      ).data.notifications;
      expect(items.find((item) => item.id === MINE)?.is_read).toBe(true);
      expect(items.find((item) => item.id === BROADCAST)?.is_read).toBe(false);
      expect(reads).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
