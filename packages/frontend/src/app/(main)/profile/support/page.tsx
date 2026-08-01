'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ChevronLeft, Loader2, SendHorizontal } from 'lucide-react';
import type { SupportMessage } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useMarkSupportReadMutation,
  useSendSupportMessageMutation,
  useSupportConversationQuery,
} from '@/lib/api/support';
import { useTelegramBackButton } from '@/lib/telegram';
import { pendingOutbox, type PendingSupportMessage } from '@/lib/utils/notifications';

const GREETING = '你好，这里是星尘客服。请描述你遇到的问题，我们会尽快回复。';

export default function SupportPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const query = useSupportConversationQuery();
  const send = useSendSupportMessageMutation();
  const markRead = useMarkSupportReadMutation();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingSupportMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = query.data?.conversation?.messages ?? [];
  const outbox = pendingOutbox(pending, messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, outbox.length]);

  // 打开聊天页即视为读过客服回复。按最新一条回复的时间戳记账，页面开着时轮询到新回复
  // 也会再推一次已读水位线，否则用户明明正看着，红点还会在「我的」页亮起来。
  const latestAgentReplyAt =
    messages.filter((message) => message.sender === 'agent').at(-1)?.created_at ?? null;
  const markedAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestAgentReplyAt || markedAtRef.current === latestAgentReplyAt) return;
    markedAtRef.current = latestAgentReplyAt;
    markRead.mutate();
    // markRead 每次渲染都是新引用，只依赖水位线本身。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestAgentReplyAt]);

  const submit = (body: string, clientMsgId: string) => {
    setPending((current) => [
      ...current.filter((item) => item.clientMsgId !== clientMsgId),
      { clientMsgId, body, status: 'sending' },
    ]);
    send.mutate(
      { body, client_msg_id: clientMsgId },
      {
        onError: () => {
          // 提交失败必须能看出来没发出去，并把内容还给输入框。
          setPending((current) =>
            current.map((item) =>
              item.clientMsgId === clientMsgId ? { ...item, status: 'failed' } : item
            )
          );
          setDraft((current) => (current.trim() ? current : body));
        },
      }
    );
  };

  const handleSend = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    submit(body, createClientMsgId());
  };

  const retry = (item: PendingSupportMessage) => {
    setDraft('');
    submit(item.body, item.clientMsgId);
  };

  const connected = query.isSuccess && !query.isError;

  return (
    <main className="mx-auto flex h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">联系客服</h1>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              connected ? 'bg-[hsl(var(--glow))]' : 'bg-muted-foreground/60'
            )}
          />
          {connected ? '在线' : '连接中'}
        </div>
      </header>

      <section className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {query.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            加载中
          </div>
        ) : (
          <>
            <AgentBubble body={GREETING} />
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {outbox.map((item) => (
              <div key={item.clientMsgId} className="flex flex-col items-end gap-1">
                <div
                  className={cn(
                    'max-w-[78%] rounded-[18px] rounded-br-md bg-primary px-3.5 py-2.5 text-[14px] leading-relaxed text-primary-foreground',
                    item.status === 'failed' && 'opacity-60'
                  )}
                >
                  {item.body}
                </div>
                {item.status === 'failed' ? (
                  <button
                    type="button"
                    onClick={() => retry(item)}
                    className="flex items-center gap-1 text-[11px] font-semibold text-destructive"
                  >
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                    发送失败，点击重试
                  </button>
                ) : null}
              </div>
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </section>

      <div className="sticky bottom-0 flex items-end gap-2 border-t border-border bg-background/90 px-3 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur-xl">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder="说说你遇到的问题…"
          aria-label="输入要发送给客服的问题"
          className="max-h-32 min-h-[42px] flex-1 resize-none rounded-[20px] border border-border bg-card px-4 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          type="button"
          size="icon"
          onClick={handleSend}
          disabled={!draft.trim()}
          aria-label="发送"
          className="h-[42px] w-[42px] shrink-0 rounded-full"
        >
          <SendHorizontal className="h-[18px] w-[18px]" aria-hidden />
        </Button>
      </div>
    </main>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  if (message.sender === 'agent') return <AgentBubble body={message.body} />;
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-[18px] rounded-br-md bg-primary px-3.5 py-2.5 text-[14px] leading-relaxed text-primary-foreground">
        {message.body}
      </div>
    </div>
  );
}

function AgentBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[78%] rounded-[18px] rounded-bl-md border border-border bg-card px-3.5 py-2.5">
        <span className="mb-1 block text-[10px] font-bold tracking-wide text-primary">
          官方客服
        </span>
        <span className="block whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
          {body}
        </span>
      </div>
    </div>
  );
}

function createClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
