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
    <main className="min-h-dvh bg-[#0e0918] px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))] text-white">
      <header className="mx-auto mb-5 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#ef856d]">Messages</p>
        <h1 className="mt-1 text-2xl font-bold">历史聊天</h1>
        <p className="mt-1 text-sm text-white/55">继续最近与角色的对话，上下文会完整保留。</p>
      </header>

      <section className="mx-auto max-w-2xl space-y-2">
        {loading && items.length === 0 ? (
          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 text-center text-sm text-white/55">
            正在读取历史对话…
          </div>
        ) : null}

        {error ? (
          <div className="rounded-3xl border border-red-400/25 bg-red-400/[0.07] p-5">
            <p className="text-sm text-red-200">历史聊天加载失败，请稍后重试。</p>
            <button
              type="button"
              onClick={() => void fetch()}
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#ef856d] px-4 py-2 text-sm font-semibold text-[#24111a] transition active:scale-95"
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </button>
          </div>
        ) : null}

        {!loading && !error && items.length === 0 ? (
          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 text-center">
            <MessageCircle className="mx-auto h-9 w-9 text-[#ef856d]" />
            <h2 className="mt-3 font-semibold">还没有有效对话</h2>
            <p className="mt-1 text-sm text-white/55">与角色至少发送一句消息后会显示在这里。</p>
            <Link
              href="/"
              className="mt-4 inline-flex rounded-full bg-[#ef856d] px-5 py-2.5 text-sm font-semibold text-[#24111a] transition active:scale-95"
            >
              去选择角色
            </Link>
          </div>
        ) : null}

        {items.map((item) => {
          if (!item.characterId) return null;
          const search = new URLSearchParams({ chat: item.fileName });
          return (
            <Link
              key={item.characterId}
              href={`/tavern/${item.characterId}?${search.toString()}`}
              prefetch={false}
              className="flex items-center gap-3 rounded-3xl border border-white/10 bg-white/[0.05] p-3.5 shadow-lg shadow-black/10 transition hover:border-white/20 hover:bg-white/[0.075] active:scale-[0.99]"
            >
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-white/10">
                {item.characterAvatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.characterAvatarUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover object-top"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[#ef856d]">
                    <MessageCircle className="h-5 w-5" />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate font-semibold">{item.characterName}</span>
                  <time className="shrink-0 text-[11px] text-white/45">
                    {formatActivityTime(item.lastMessageAt)}
                  </time>
                </span>
                <span className="mt-1 block truncate text-sm text-white/55">
                  {item.lastMessage || '暂无消息摘要'}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
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
