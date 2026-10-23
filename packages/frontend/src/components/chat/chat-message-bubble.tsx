'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage } from '@miniapp/shared';
import { ReplyRenderer, type ReplyChoicePayload } from '@miniapp/reply-renderer';

import { observeFirstVisibleToken } from '@/lib/perf/first-token-observation';
import { cn } from '@/lib/utils';
import type { AssistantBodyPlan } from '@/lib/text-postprocess/reply-plan';
import { CHAT_MARKDOWN_CLASS, ChatMarkdown } from './chat-markdown';
import { getChatReplyPresentation } from './chat-reply-presentation';

/**
 * 字号/行高/头像尺寸等取值照搬原版聊天页注入 ST iframe 的那套样式
 * （st-extension/src/patches/mobile-chat-theme.ts，本文件不引用它，只对齐取值）。
 *
 * 原版把桌面尺寸写成基准、520px 以下再覆盖；Tailwind 是移动优先，方向相反，
 * 所以这里基准取窄屏值，min-[521px] 补回宽屏值，落到像素上两边一致。
 *
 * 关键一点：AI 消息在原版里没有气泡——透明底、无边框，正文直接铺在背景上，
 * 只有用户消息才是气泡。带底色的卡片会让长回复看起来被关进框里，和原版差别很大。
 *
 * 布局上与原版有意不同：头像和标题/发送方单独占一行放在正文上方，正文自己独立成行，
 * 左右 padding 完全对称。原版把头像和正文放在同一行、头像占掉左侧空间，
 * 这会让 body 规则里的 `text-align: justify` 在一个左右不对称的容器里生效，
 * 两端对齐的效果被挤偏到右边，视觉上不居中。头像挪到上方后正文容器天然对称，
 * justify 才能展现出「正文整体居中、左右两端对齐」的效果。
 *
 * AI 正文区本身限制到 620px 并用 `mx-auto` 居中，而不是只给外层加 padding。
 * 窄屏两侧各留 32px，521px 以上各留至少 48px；超过 620px 后两侧留白继续自然增加。
 * 头像和标题也放进同一个容器，保证消息的各部分使用同一条对齐线。
 */
const AVATAR_CLASS =
  'size-[34px] shrink-0 rounded-full border border-border object-cover min-[521px]:size-9';

/** 头像挪到正文上方后单独占一行，尺寸比行内嵌入时更大一些，和正文的视觉比例更协调 */
const HEADER_AVATAR_CLASS =
  'size-10 shrink-0 rounded-full border border-border object-cover min-[521px]:size-11';

const BODY_TEXT_CLASS =
  'text-[14.5px] font-[440] leading-[1.76] min-[521px]:text-[15px] min-[521px]:leading-[1.72]';

const ASSISTANT_CONTENT_CLASS =
  'mx-auto w-[calc(100%-4rem)] max-w-[620px] min-w-0 min-[521px]:w-[calc(100%-6rem)]';

/**
 * 角色名/会话标题：比正文小一档、颜色用 muted，做成一行轻提示而不是加粗的强标题，
 * 避免和正文抢视觉重心。
 */
const HEADER_TITLE_CLASS =
  'truncate text-[13.5px] font-medium text-muted-foreground min-[521px]:text-[14px]';

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onFirstTokenDisplayed?: (at: number) => void;
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
  /** 有校验过的 artifact 才走 ReplyRenderer。否则保持原来的 Markdown。 */
  replyPlan?: AssistantBodyPlan;
  displayName?: string;
  choiceDisabled?: boolean;
  onChoice?: (choice: ReplyChoicePayload) => void;
  detailsDefaultOpen?: Readonly<Record<string, boolean>>;
}

export function ChatMessageBubble({
  message,
  onFirstTokenDisplayed,
  characterName,
  characterAvatarUrl,
  userAvatarUrl,
  streaming,
  stalled,
  quotaExhaustedNotice,
  footer,
  replyPlan,
  displayName,
  choiceDisabled,
  onChoice,
  detailsDefaultOpen,
}: ChatMessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1 px-6 pb-2.5 pt-1.5 min-[521px]:px-10">
        <Avatar url={userAvatarUrl} alt="" className={HEADER_AVATAR_CLASS} />
        <div className="w-fit max-w-full whitespace-pre-wrap rounded-[20px_20px_6px_20px] border border-primary/[0.18] bg-bubble-user px-3.5 py-[11px] text-foreground min-[521px]:max-w-[30rem]">
          <span className={BODY_TEXT_CLASS}>{message.content}</span>
        </div>
      </div>
    );
  }

  const presentation = getChatReplyPresentation(message);

  return (
    <div className="pb-3.5 pt-3">
      <div className={ASSISTANT_CONTENT_CLASS}>
        <div className="mb-1.5 flex min-h-[24px] items-center gap-2">
          <Avatar url={characterAvatarUrl} alt="" className={HEADER_AVATAR_CLASS} />
          <span className={HEADER_TITLE_CLASS}>{characterName}</span>
        </div>
        <div className="min-w-0">
          <div className={cn('text-foreground', BODY_TEXT_CLASS)}>
            {message.content ? (
              <AssistantReplyBody
                message={message}
                onFirstTokenDisplayed={onFirstTokenDisplayed}
                plan={replyPlan ?? { kind: 'original' }}
                streaming={Boolean(streaming)}
                displayName={displayName}
                choiceDisabled={choiceDisabled !== false}
                onChoice={onChoice}
                detailsDefaultOpen={detailsDefaultOpen}
              />
            ) : null}
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
    <div className="pb-3.5 pt-3">
      <div className={ASSISTANT_CONTENT_CLASS}>
        <div className="mb-1.5 flex min-h-[24px] items-center gap-2">
          <Avatar url={characterAvatarUrl} alt="" className={HEADER_AVATAR_CLASS} />
          <span className={HEADER_TITLE_CLASS}>{characterName}</span>
        </div>
        <div className="flex items-center gap-1 pt-1">
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

function AssistantReplyBody({
  message,
  onFirstTokenDisplayed,
  plan,
  streaming,
  displayName,
  choiceDisabled,
  onChoice,
  detailsDefaultOpen,
}: {
  message: ChatMessage;
  onFirstTokenDisplayed?: (at: number) => void;
  plan: AssistantBodyPlan;
  streaming: boolean;
  displayName?: string;
  choiceDisabled: boolean;
  onChoice?: (choice: ReplyChoicePayload) => void;
  detailsDefaultOpen?: Readonly<Record<string, boolean>>;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const displayCallback = useRef(onFirstTokenDisplayed);
  displayCallback.current = onFirstTokenDisplayed;
  const observingDisplay = Boolean(onFirstTokenDisplayed);
  useEffect(() => {
    // A new delta creates new callbacks every frame. Keep the observer alive so its
    // paint opportunity is not repeatedly cancelled by a continuous token stream.
    if (node && observingDisplay)
      return observeFirstVisibleToken(node, (at) => displayCallback.current?.(at));
  }, [node, observingDisplay, message.id, message.revision]);
  const onScreen = useStayOnScreen(node, plan.kind === 'renderer');
  // 流式增量必须保留原来的稳定 Markdown DOM；逐片重跑 Worker 会让已出现正文
  // 在 pending/applied 之间整棵替换。终态再一次性挂 renderer，交互也只此时开放。
  const showRenderer = plan.kind === 'renderer' && onScreen && !streaming;

  return (
    <div ref={setNode}>
      {showRenderer ? (
        <ReplyRenderer
          content={message.content}
          artifact={plan.artifact}
          streaming={streaming}
          displayName={displayName}
          theme="dark"
          choiceDisabled={choiceDisabled || streaming}
          onChoice={choiceDisabled || streaming ? undefined : onChoice}
          messageKey={`${message.id}:${message.revision}`}
          className={CHAT_MARKDOWN_CLASS}
          detailsDefaultOpen={detailsDefaultOpen}
        />
      ) : (
        <ChatMarkdown content={message.content} />
      )}
    </div>
  );
}

/**
 * 视口外先留着原来的 Markdown，进入视口后再挂渲染器。
 * 一旦挂上就保持挂载，避免滚走以后丢掉状态卡的展开状态。
 * 观察放在 effect 里，模块加载和 SSR 都不碰 window / Worker。
 */
function useStayOnScreen(node: HTMLDivElement | null, enabled: boolean): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!enabled || visible) return;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: '240px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, node, visible]);
  return visible;
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

function Avatar({
  url,
  alt,
  className = AVATAR_CLASS,
}: {
  url: string | null;
  alt: string;
  className?: string;
}) {
  if (!url) return <span className={cn(className, 'bg-secondary')} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} loading="lazy" className={className} />
  );
}
