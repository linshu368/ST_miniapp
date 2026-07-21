'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ChevronRight, MessageCircle, RefreshCw } from 'lucide-react';
import { useChatListStore } from '@/stores/chat-list';

export default function ChatsPage() {
  const { items, loading, error, fetch } = useChatListStore();

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return (
    <main className="min-h-dvh bg-background px-4 pb-28 pt-6 text-foreground">
      <header className="mx-auto mb-5 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Messages</p>
        <h1 className="mt-1 text-2xl font-bold">历史聊天</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          继续最近与角色的对话，上下文会完整保留。
        </p>
      </header>

      <section className="mx-auto max-w-2xl space-y-2">
        {loading && items.length === 0 ? (
          <div className="rounded-3xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            正在读取历史对话…
          </div>
        ) : null}

        {error ? (
          <div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-5">
            <p className="text-sm text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => void fetch()}
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </button>
          </div>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <div className="rounded-3xl border border-border bg-card p-8 text-center">
            <MessageCircle className="mx-auto h-9 w-9 text-primary" />
            <h2 className="mt-3 font-semibold">还没有有效对话</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              与角色完成至少一轮对话后会显示在这里。
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              去选择角色
            </Link>
          </div>
        ) : null}

        {items.map((item) => {
          const search = new URLSearchParams({ chat: item.fileName });
          return (
            <Link
              key={`${item.characterAvatar}/${item.fileName}`}
              href={`/tavern/${item.characterId}?${search.toString()}`}
              prefetch={false}
              className="flex items-center gap-3 rounded-3xl border border-border bg-card p-4 shadow-sm transition hover:border-primary/35 hover:shadow-md active:scale-[0.99]"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <MessageCircle className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate font-semibold">
                    {item.characterName || '未命名角色'}
                  </span>
                  <time className="shrink-0 text-[11px] text-muted-foreground">
                    {formatActivityTime(item.lastMessageAt)}
                  </time>
                </span>
                <span className="mt-1 block truncate text-sm text-muted-foreground">
                  {item.lastMessage || '暂无消息摘要'}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </section>
    </main>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
