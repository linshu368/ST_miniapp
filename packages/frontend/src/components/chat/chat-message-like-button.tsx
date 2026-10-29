'use client';

import { useEffect, useRef, useState } from 'react';
import { ThumbsUp } from 'lucide-react';
import type { ChatMessage, SetMessageLikeData } from '@miniapp/shared';
import { useSetMessageLikeMutation } from '@/lib/api/conversations';
import { useHaptic } from '@/lib/telegram/hooks';
import { cn } from '@/lib/utils';

export interface MessageLikeFeedback {
  sessionId: string;
  messageId: string;
  text: string | null;
}

export function ChatMessageLikeButton({
  message,
  onConfirmed,
  onFeedback,
}: {
  message: ChatMessage;
  onConfirmed: (data: SetMessageLikeData) => void;
  onFeedback: (feedback: MessageLikeFeedback) => void;
}) {
  const mutation = useSetMessageLikeMutation();
  const { selection } = useHaptic();
  const locked = useRef(false);
  const [optimisticLiked, setOptimisticLiked] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const savedLiked = message.liked ?? false;
  const liked = optimisticLiked ?? savedLiked;

  // 详情缓存或旧分页确认更新后再交回服务端值，避免请求结束时闪回旧图标。
  useEffect(() => {
    if (!pending && optimisticLiked === savedLiked) setOptimisticLiked(null);
  }, [pending, optimisticLiked, savedLiked]);

  const toggle = async () => {
    if (locked.current) return;
    locked.current = true;
    const next = !liked;
    const identity = { sessionId: message.session_id, messageId: message.id };
    setOptimisticLiked(next);
    setPending(true);
    onFeedback({ ...identity, text: null });
    selection();
    try {
      const data = await mutation.mutateAsync({ ...identity, liked: next });
      onConfirmed(data);
      setOptimisticLiked(data.liked);
    } catch {
      setOptimisticLiked(null);
      onFeedback({ ...identity, text: '点赞没能保存，请再试一次。' });
    } finally {
      locked.current = false;
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      aria-label={liked ? '取消点赞' : '点赞这条回复'}
      title={`赞第 ${message.turn_index} 轮回复`}
      aria-pressed={liked}
      aria-busy={pending}
      disabled={pending}
      onClick={() => void toggle()}
      className={cn(
        'inline-flex size-12 shrink-0 items-center justify-center rounded-full transition-colors active:bg-primary/10 motion-safe:active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait',
        liked
          ? 'text-primary hover:bg-primary/10'
          : 'text-muted-foreground/70 hover:bg-secondary hover:text-foreground'
      )}
    >
      <ThumbsUp className={cn('size-4', liked ? 'fill-primary/25' : 'fill-none')} aria-hidden />
    </button>
  );
}
