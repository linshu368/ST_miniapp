import {
  isOutsideNotificationUnreadWindow,
  type NotificationItem,
  type NotificationScope,
} from '@miniapp/shared';

/**
 * 消息中心的本地虚构数据：两个分类各有近期消息和超过 14 天的旧消息。
 * 只在 `messages` 场景接管 /api/notifications*，其它场景仍走 server.ts 里的心愿通知逻辑。
 */
export const MESSAGE_CENTER_SCENARIOS = {
  messages: {
    label: '消息中心',
    description: '分类红点、全部已读、14 天前的消息整组收起；从详情返回保留分类与展开',
  },
} as const;

const DAY = 86_400_000;

type Seed = [NotificationScope, NotificationItem['category'], string, string, number, boolean];

const SEEDS: Seed[] = [
  ['official', 'announcement', '本周版本更新', '记忆栏搬进状态栏，长对话更稳了。', 0.05, false],
  ['official', 'activity', '周末签到加成', '本周末签到额外加 30 星尘。', 2, false],
  ['official', 'announcement', '支付通道恢复', '支付已恢复正常，感谢耐心等待。', 5, true],
  ['official', 'announcement', '服务异常说明', '昨晚服务短暂异常，现已恢复。', 20, false],
  ['official', 'announcement', '语音功能上线', '聊天页工具箱可以调整声色与倍速。', 40, false],
  ['official', 'activity', '补偿星尘到账', '您的补偿 1000 星尘已到账', 60, true],
  ['personal', 'system', '星尘充值到账', '订单 PREVIEW-1 已完成，680 星尘已到账。', 0.1, false],
  ['personal', 'system', 'VIP 月卡已生效', '订单 PREVIEW-2 已完成，会员已顺延 31 天。', 1, true],
  ['personal', 'system', '星尘充值到账', '订单 PREVIEW-3 已完成，1580 星尘已到账。', 30, true],
];

interface Entry {
  item: Omit<NotificationItem, 'is_read'>;
  read: boolean;
}

function seed(now: number): Entry[] {
  return SEEDS.map(([scope, category, title, body, daysAgo, read], index) => {
    const at = new Date(now - daysAgo * DAY).toISOString();
    return {
      item: {
        id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        scope,
        category,
        title,
        body,
        published_at: at,
        created_at: at,
        kind: null,
        action_path: null,
        metadata: null,
      },
      read,
    };
  });
}

export function createMessageCenterFixture() {
  let entries: Entry[] = [];
  const view = (entry: Entry): NotificationItem => ({
    ...entry.item,
    is_read: entry.read || isOutsideNotificationUnreadWindow(entry.item.published_at, Date.now()),
  });
  const unreadIn = (scope: NotificationScope) =>
    entries.filter((entry) => entry.item.scope === scope && !view(entry).is_read);

  return {
    reset() {
      entries = seed(Date.now());
    },
    handle(
      method: string,
      path: string,
      url: URL,
      body: unknown,
      scenario: string
    ): unknown | undefined {
      if (scenario !== 'messages') return undefined;
      if (path === '/api/notifications/unread-count' && method === 'GET') {
        const official = unreadIn('official').length;
        const personal = unreadIn('personal').length;
        return { official, personal, total: official + personal };
      }
      if (path === '/api/notifications' && method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'official';
        return {
          notifications: entries
            .filter((entry) => entry.item.scope === scope)
            .sort((a, b) => b.item.published_at.localeCompare(a.item.published_at))
            .map(view),
          next_cursor: null,
        };
      }
      if (path === '/api/notifications/read' && method === 'POST') {
        const request = (body ?? {}) as { ids?: unknown; scope?: unknown; all?: unknown };
        const targets =
          request.all === true && (request.scope === 'official' || request.scope === 'personal')
            ? unreadIn(request.scope)
            : entries.filter(
                (entry) =>
                  Array.isArray(request.ids) &&
                  request.ids.includes(entry.item.id) &&
                  !view(entry).is_read
              );
        for (const entry of targets) entry.read = true;
        return { marked: targets.length };
      }
      if (path.startsWith('/api/notifications/') && method === 'GET') {
        const entry = entries.find((candidate) => candidate.item.id === path.split('/').pop());
        return entry ? { notification: view(entry) } : undefined;
      }
      return undefined;
    },
  };
}
