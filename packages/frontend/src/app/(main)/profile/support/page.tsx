'use client';

import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { usePageReady } from '@/lib/perf/page-ready';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ChevronLeft, ImagePlus, Loader2, SendHorizontal, X } from 'lucide-react';
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
import { prepareSupportImage, type PreparedSupportImage } from '@/lib/utils/support-image';

const GREETING = '你好，这里是星尘客服。请描述你遇到的问题，我们会尽快回复。';

export default function SupportPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const query = useSupportConversationQuery();
  usePageReady('/profile/support', query.data !== undefined);
  const send = useSendSupportMessageMutation();
  const markRead = useMarkSupportReadMutation();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingSupportMessage[]>([]);
  const [image, setImage] = useState<PreparedSupportImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const pickImage = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setImageError(null);
    setPreparing(true);
    try {
      setImage(await prepareSupportImage(file));
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '图片处理失败');
    } finally {
      setPreparing(false);
    }
  };

  const submit = (body: string, clientMsgId: string, attached?: PreparedSupportImage) => {
    const action = startAction('support_send_message');
    setPending((current) => [
      ...current.filter((item) => item.clientMsgId !== clientMsgId),
      { clientMsgId, body, image: attached, status: 'sending' },
    ]);
    feedbackAfterPaint(action);
    send.mutate(
      {
        body,
        client_msg_id: clientMsgId,
        ...(attached ? { image: { data_base64: attached.base64 } } : {}),
      },
      {
        onError: () => {
          // 提交失败必须能看出来没发出去，并把内容还给输入框。
          setPending((current) =>
            current.map((item) =>
              item.clientMsgId === clientMsgId ? { ...item, status: 'failed' } : item
            )
          );
          // 带图的失败消息留在列表里点重试，不把文字还给输入框，免得重试和重新发送变成两条
          if (!attached) setDraft((current) => (current.trim() ? current : body));
        },
      }
    );
  };

  const canSend = (draft.trim() !== '' || image !== null) && !preparing;
  const handleSend = () => {
    const body = draft.trim();
    if (!canSend) return;
    setDraft('');
    setImage(null);
    submit(body, createClientMsgId(), image ?? undefined);
  };

  const retry = (item: PendingSupportMessage) => {
    if (!item.image) setDraft('');
    submit(item.body, item.clientMsgId, item.image);
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
              <MessageBubble key={message.id} message={message} onViewImage={setViewing} />
            ))}
            {outbox.map((item) => (
              <div key={item.clientMsgId} className="flex flex-col items-end gap-1">
                <div
                  className={cn(
                    'flex max-w-[78%] flex-col items-end gap-1',
                    item.status === 'failed' && 'opacity-60'
                  )}
                >
                  {item.image ? <SupportImage src={item.image.previewUrl} /> : null}
                  {item.body ? <UserText body={item.body} /> : null}
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

      <div className="sticky bottom-0 border-t border-border bg-background/90 px-3 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur-xl">
        {image || imageError ? (
          <div className="mb-2 flex items-end gap-2 px-1">
            {image ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.previewUrl}
                  alt="待发送的图片"
                  className="h-20 max-w-[8rem] rounded-xl border border-border object-cover"
                />
                <button
                  type="button"
                  onClick={() => setImage(null)}
                  aria-label="移除图片"
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
            {imageError ? <span className="text-[12px] text-destructive">{imageError}</span> : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(event) => void pickImage(event.target.files?.[0])}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileRef.current?.click()}
            disabled={preparing}
            aria-label="发送截图"
            className="h-[42px] w-[42px] shrink-0 rounded-full text-muted-foreground"
          >
            {preparing ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden />
            ) : (
              <ImagePlus className="h-[18px] w-[18px]" aria-hidden />
            )}
          </Button>
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
            placeholder={image ? '补充说明（可不填）' : '说说你遇到的问题，也可以发截图'}
            aria-label="输入要发送给客服的问题"
            className="max-h-32 min-h-[42px] flex-1 resize-none rounded-[20px] border border-border bg-card px-4 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            type="button"
            size="icon"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="发送"
            className="h-[42px] w-[42px] shrink-0 rounded-full"
          >
            <SendHorizontal className="h-[18px] w-[18px]" aria-hidden />
          </Button>
        </div>
      </div>

      {viewing ? (
        <button
          type="button"
          onClick={() => setViewing(null)}
          aria-label="关闭图片"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing} alt="图片" className="max-h-full max-w-full object-contain" />
        </button>
      ) : null}
    </main>
  );
}

function MessageBubble({
  message,
  onViewImage,
}: {
  message: SupportMessage;
  onViewImage: (url: string) => void;
}) {
  const image = message.image_url ? (
    <SupportImage src={message.image_url} onClick={() => onViewImage(message.image_url!)} />
  ) : null;
  if (message.sender === 'agent') return <AgentBubble body={message.body} image={image} />;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex max-w-[78%] flex-col items-end gap-1">
        {image}
        {message.body ? <UserText body={message.body} /> : null}
      </div>
    </div>
  );
}

function UserText({ body }: { body: string }) {
  return (
    <div className="whitespace-pre-wrap rounded-[18px] rounded-br-md bg-primary px-3.5 py-2.5 text-[14px] leading-relaxed text-primary-foreground">
      {body}
    </div>
  );
}

function SupportImage({ src, onClick }: { src: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="block overflow-hidden rounded-2xl"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="图片"
        loading="lazy"
        className="max-h-64 max-w-full bg-secondary object-contain"
      />
    </button>
  );
}

function AgentBubble({ body, image }: { body: string; image?: ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[78%] rounded-[18px] rounded-bl-md border border-border bg-card px-3.5 py-2.5">
        <span className="mb-1 block text-[10px] font-bold tracking-wide text-primary">
          官方客服
        </span>
        {image ? <div className="mb-1.5">{image}</div> : null}
        {body ? (
          <span className="block whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
            {body}
          </span>
        ) : null}
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
