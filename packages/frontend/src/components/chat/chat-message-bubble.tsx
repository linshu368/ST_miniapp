'use client';

import type { ReactNode } from 'react';
import type { ChatMessage } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { ChatMarkdown } from './chat-markdown';
import { getChatReplyPresentation } from './chat-reply-presentation';

/**
 * 几何全部照搬原版聊天页注入 ST iframe 的那套样式
 * （st-extension/src/patches/mobile-chat-theme.ts，本文件不引用它，只对齐取值）。
 *
 * 原版把桌面尺寸写成基准、520px 以下再覆盖；Tailwind 是移动优先，方向相反，
 * 所以这里基准取窄屏值，min-[521px] 补回宽屏值，落到像素上两边一致。
 *
 * 关键一点：AI 消息在原版里没有气泡——透明底、无边框，正文直接铺在背景上，
 * 只有用户消息才是气泡。带底色的卡片会让长回复看起来被关进框里，和原版差别很大。
 */
const AVATAR_CLASS =
  'size-[34px] shrink-0 rounded-full border border-border object-cover min-[521px]:size-9';

const BODY_TEXT_CLASS =
  'text-[14.5px] font-[440] leading-[1.76] min-[521px]:text-[15px] min-[521px]:leading-[1.72]';

interface ChatMessageBubbleProps {
  message: ChatMessage;
  /** 角色名，显示在 AI 消息正文上方 */
  characterName: string;
  characterAvatarUrl: string | null;
  userAvatarUrl: string | null;
  /** 正在流式写入这条消息。此时用 message.content 承载已收到的增量 */
  streaming?: boolean;
  /** 一段时间没有收到新内容，但生成尚未终止 */
  stalled?: boolean;
  /** 本轮刚好用完该角色卡免费额度时，挂在回复正文下的轻提示 */
  quotaExhaustedNotice?: string;
  /** 挂在正文下方的操作区，目前只有重生成按钮 */
  footer?: ReactNode;
}

export function ChatMessageBubble({
  message,
  characterName,
  characterAvatarUrl,
  userAvatarUrl,
  streaming,
  stalled,
  quotaExhaustedNotice,
  footer,
}: ChatMessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex items-end justify-end gap-2 px-3.5 pb-2.5 pt-1.5">
        <div className="w-fit max-w-[calc(100%-42px)] whitespace-pre-wrap rounded-[20px_20px_6px_20px] border border-primary/[0.18] bg-bubble-user px-3.5 py-[11px] text-foreground min-[521px]:max-w-[min(calc(100%-44px),34rem)]">
          <span className={BODY_TEXT_CLASS}>{message.content}</span>
        </div>
        <Avatar url={userAvatarUrl} alt="" />
      </div>
    );
  }

  const presentation = getChatReplyPresentation(message);

  return (
    <div className="flex items-start px-3.5 pb-3.5 pt-3 min-[521px]:px-4">
      <Avatar url={characterAvatarUrl} alt="" />
      <div className="min-w-0 max-w-[calc(100%-42px)] flex-1 pl-2.5 min-[521px]:max-w-[calc(100%-46px)]">
        <div className="min-h-[18px] truncate text-[13px] font-[650] text-foreground">
          {characterName}
        </div>
        <div className={cn('pt-1 text-foreground', BODY_TEXT_CLASS)}>
          {message.content ? <ChatMarkdown content={message.content} /> : null}
          {streaming ? (
            <span
              className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse bg-primary align-middle"
              aria-hidden
            />
          ) : null}
          {stalled ? <ReplyNotice>TA 回应得有点久，再等一会儿。</ReplyNotice> : null}
          {presentation === 'incomplete' && message.finish_reason === 'content_filter' ? (
            <ReplyNotice>回复停在这里了，可以重新回复。本次未扣星尘。</ReplyNotice>
          ) : presentation === 'empty' ? (
            <ReplyNotice>TA 刚才没能回应，可以再试一次。本次未扣星尘。</ReplyNotice>
          ) : null}
          {quotaExhaustedNotice ? <ReplyNotice>{quotaExhaustedNotice}</ReplyNotice> : null}
        </div>
        {footer ? <div className="pt-1.5">{footer}</div> : null}
      </div>
    </div>
  );
}

/** 首帧还没到、只有占位时的呼吸点。位置与 AI 消息正文对齐 */
export function ChatTypingBubble({
  characterName,
  characterAvatarUrl,
  stalled,
}: {
  characterName: string;
  characterAvatarUrl: string | null;
  stalled?: boolean;
}) {
  return (
    <div className="flex items-start px-3.5 pb-3.5 pt-3 min-[521px]:px-4">
      <Avatar url={characterAvatarUrl} alt="" />
      <div className="min-w-0 flex-1 pl-2.5">
        <div className="min-h-[18px] truncate text-[13px] font-[650] text-foreground">
          {characterName}
        </div>
        <div className="flex items-center gap-1 pt-2.5">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="size-1.5 rounded-full bg-primary/70"
              style={{ animation: `splash-dot 1.3s ease-in-out ${index * 0.18}s infinite` }}
            />
          ))}
        </div>
        {stalled ? <ReplyNotice>TA 回应得有点久，再等一会儿。</ReplyNotice> : null}
      </div>
    </div>
  );
}

function ReplyNotice({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-2 border-l-2 border-border/80 pl-2 text-[11px] leading-relaxed text-muted-foreground"
      aria-live="polite"
    >
      {children}
    </p>
  );
}

function Avatar({ url, alt }: { url: string | null; alt: string }) {
  if (!url) return <span className={cn(AVATAR_CLASS, 'bg-secondary')} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} loading="lazy" className={AVATAR_CLASS} />
  );
}
