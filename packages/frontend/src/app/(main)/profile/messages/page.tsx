'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, ChevronLeft, Inbox, Loader2, RefreshCw } from 'lucide-react';
import type { NotificationItem, NotificationScope } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMarkNotificationsReadMutation, useNotificationsQuery } from '@/lib/api/notifications';
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

  const [scope, setScope] = useState<NotificationScope>('official');
  const query = useNotificationsQuery(scope);
  const markRead = useMarkNotificationsReadMutation();
  const notifications = query.data?.notifications ?? [];

  // 打开某个分页即视为读过该分页，两处红点同时消失；每个分页只提交一次。
  const markedScopes = useRef(new Set<NotificationScope>());
  const hasUnread = notifications.some((item) => !item.is_read);
  useEffect(() => {
    if (!hasUnread || markedScopes.current.has(scope)) return;
    markedScopes.current.add(scope);
    markRead.mutate({ scope });
  }, [hasUnread, markRead, scope]);

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

        <div role="tablist" aria-label="消息分类" className="flex gap-1 px-3">
          {TABS.map((tab) => {
            const active = tab.scope === scope;
            return (
              <button
                key={tab.scope}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setScope(tab.scope)}
                className={cn(
                  'relative px-4 pb-2.5 pt-1 text-sm font-bold transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80'
                )}
              >
                {tab.label}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
                  />
                ) : null}
              </button>
            );
          })}
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
            <p className="text-[13px] font-medium text-muted-foreground">消息暂时无法加载</p>
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
          notifications.map((item) => <MessageCard key={item.id} item={item} />)
        )}
      </section>
    </main>
  );
}

function MessageCard({ item }: { item: NotificationItem }) {
  return (
    <article className="rounded-[22px] border border-border bg-card px-4 py-3.5">
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
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
        {item.body}
      </p>
    </article>
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
        {official ? '暂无官方消息' : '暂无消息'}
      </p>
      <p className="text-[12px]">
        {official ? '官方公告发布后会出现在这里。' : '系统通知和互动消息会出现在这里。'}
      </p>
    </div>
  );
}
