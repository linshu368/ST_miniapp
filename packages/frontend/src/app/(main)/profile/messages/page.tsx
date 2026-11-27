'use client';

import { usePageReady } from '@/lib/perf/page-ready';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Inbox,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  isOutsideNotificationUnreadWindow,
  type NotificationItem,
  type NotificationScope,
} from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useMarkNotificationsReadMutation,
  useNotificationsQuery,
  useNotificationUnreadCountQuery,
} from '@/lib/api/notifications';
import {
  clearMessageListView,
  peekMessageListView,
  rememberMessageListView,
} from '@/lib/notifications/list-view-memory';
import { useTelegramBackButton } from '@/lib/telegram';
import { formatMessageTime } from '@/lib/utils/notifications';

const TABS: Array<{ scope: NotificationScope; label: string }> = [
  { scope: 'official', label: '官方' },
  { scope: 'personal', label: '消息' },
];

const CATEGORY_LABELS: Record<NotificationItem['category'], string> = {
  announcement: '官方公告',
  activity: '活动',
  system: '系统',
  interaction: '互动',
};

export default function MessageCenterPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const [restored] = useState(peekMessageListView);
  useEffect(() => {
    clearMessageListView();
  }, []);
  const [scope, setScope] = useState<NotificationScope>(restored?.scope ?? 'official');
  const [olderExpanded, setOlderExpanded] = useState(
    restored?.olderExpanded ?? { official: false, personal: false }
  );
  const query = useNotificationsQuery(scope);
  usePageReady(
    '/profile/messages',
    query.data !== undefined && !query.isError,
    false,
    query.isError
  );
  // 轮询由常驻的 BottomNav 负责，这里只订阅缓存画分类红点。
  const unreadCount = useNotificationUnreadCountQuery({ poll: false });
  const markRead = useMarkNotificationsReadMutation();
  const markAllRead = useMarkNotificationsReadMutation();
  const notifications = useMemo(() => query.data?.notifications ?? [], [query.data]);
  const { recent, older } = useMemo(() => splitByUnreadWindow(notifications), [notifications]);
  const hasUnread = notifications.some((item) => !item.is_read);

  // 先跳详情，已读在后台写；失败只是红点多留一会儿，下次轮询会校正。
  const openMessage = useCallback(
    (item: NotificationItem) => {
      rememberMessageListView({ scope, olderExpanded });
      if (!item.is_read) markRead.mutate({ ids: [item.id] });
      router.push(`/profile/messages/${item.id}`);
    },
    [markRead, olderExpanded, router, scope]
  );
  const toggleOlder = useCallback(
    () => setOlderExpanded((current) => ({ ...current, [scope]: !current[scope] })),
    [scope]
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={goBack}
            className="rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="返回"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </Button>
          <h1 className="text-base font-bold tracking-wide">消息中心</h1>
        </div>

        <div role="tablist" aria-label="消息分类" className="flex items-end gap-1 px-3">
          {TABS.map((tab) => {
            const active = tab.scope === scope;
            const tabUnread = (unreadCount.data?.[tab.scope] ?? 0) > 0;
            return (
              <button
                key={tab.scope}
                type="button"
                role="tab"
                aria-selected={active}
                data-unread={tabUnread}
                onClick={() => setScope(tab.scope)}
                className={cn(
                  'relative px-4 pb-2.5 pt-1 text-sm font-bold transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80'
                )}
              >
                {tab.label}
                {tabUnread ? (
                  <span
                    aria-hidden
                    className="absolute right-2 top-[3px] h-1.5 w-1.5 rounded-full bg-destructive"
                  />
                ) : null}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
                  />
                ) : null}
              </button>
            );
          })}
          {hasUnread ? (
            <button
              type="button"
              onClick={() => markAllRead.mutate({ scope, all: true })}
              disabled={markAllRead.isPending}
              className="mb-1.5 ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden />
              全部已读
            </button>
          ) : null}
        </div>
      </header>

      <section
        role="tabpanel"
        className="flex flex-1 flex-col gap-3 px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
      >
        {query.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            加载中
          </div>
        ) : query.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
            <RefreshCw className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="text-[13px] font-medium text-muted-foreground">
              消息没加载出来，再试一次吧
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              className="rounded-full border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              重新加载
            </Button>
          </div>
        ) : notifications.length === 0 ? (
          <EmptyState scope={scope} />
        ) : (
          <>
            {recent.map((item) => (
              <MessageCard key={item.id} item={item} onOpen={() => openMessage(item)} />
            ))}
            {older.length > 0 ? (
              <OlderMessages
                items={older}
                expanded={olderExpanded[scope]}
                onToggle={toggleOlder}
                onOpen={openMessage}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function splitByUnreadWindow(items: NotificationItem[]): {
  recent: NotificationItem[];
  older: NotificationItem[];
} {
  const now = Date.now();
  const recent: NotificationItem[] = [];
  const older: NotificationItem[] = [];
  for (const item of items) {
    (isOutsideNotificationUnreadWindow(item.published_at, now) ? older : recent).push(item);
  }
  return { recent, older };
}

function OlderMessages({
  items,
  expanded,
  onToggle,
  onOpen,
}: {
  items: NotificationItem[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: (item: NotificationItem) => void;
}) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <>
      {expanded
        ? items.map((item) => <MessageCard key={item.id} item={item} onOpen={() => onOpen(item)} />)
        : null}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center justify-center gap-1 pb-1 pt-2.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? '收起' : `更早的 ${items.length} 条`}
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}

function MessageCard({ item, onOpen }: { item: NotificationItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-[22px] border border-border bg-card px-4 py-3.5 text-left transition hover:border-primary/25"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary">
          {CATEGORY_LABELS[item.category]}
        </span>
        <time
          dateTime={item.published_at}
          className="text-[10px] font-medium tabular-nums text-muted-foreground/70"
        >
          {formatMessageTime(item.published_at)}
        </time>
      </div>
      <h2 className="mt-2.5 flex items-start gap-1.5 text-[15px] font-bold leading-snug tracking-tight text-foreground">
        {item.is_read ? null : (
          <span
            aria-label="未读"
            className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
          />
        )}
        <span>{item.title}</span>
      </h2>
      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
        {item.body}
      </p>
    </button>
  );
}

function EmptyState({ scope }: { scope: NotificationScope }) {
  const official = scope === 'official';
  const Icon = official ? Bell : Inbox;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
      <div className="mb-1 rounded-full bg-card p-4">
        <Icon className="h-8 w-8 opacity-50" aria-hidden />
      </div>
      <p className="text-[13px] font-bold text-foreground">
        {official ? '还没有官方消息' : '还没有消息'}
      </p>
    </div>
  );
}
