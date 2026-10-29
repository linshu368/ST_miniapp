'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@miniapp/shared';
import { canBranchFromMessage } from '@/components/chat/chat-reply-presentation';
import { createConversationRequestId } from '@/lib/api/conversation-stream';
import { useForkConversationMutation } from '@/lib/api/conversations';

export function useConversationBranch({
  sessionId,
  scope,
  enabled,
  onCreated,
}: {
  sessionId: string | null;
  scope: string;
  enabled: boolean;
  onCreated: (sessionId: string) => void;
}) {
  const mutation = useForkConversationMutation();
  const requests = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const view = useRef<object | null>(null);
  const [pending, setPending] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [error, setError] = useState<{ sessionId: string; messageId: string; text: string } | null>(
    null
  );

  useLayoutEffect(() => {
    view.current = {};
    setError(null);
    return () => {
      view.current = null;
    };
  }, [sessionId, scope]);

  // 返回列表、切换会话等用户导航一开始就作废自动跳转，避免慢响应把人拉回来。
  const leaveView = useCallback(() => {
    view.current = {};
  }, []);

  const fork = async (message: ChatMessage) => {
    if (!sessionId || !enabled || inFlight.current || !canBranchFromMessage(message)) return;
    inFlight.current = true;
    const sourceSessionId = sessionId;
    const originView = view.current;
    const key = `${scope}:${sourceSessionId}:${message.id}`;
    const requestId = requests.current.get(key) ?? createConversationRequestId();
    // 网络中断时不能判断服务端是否已建好；手动重试沿用同一请求号。
    requests.current.set(key, requestId);
    setPending({ sessionId: sourceSessionId, messageId: message.id });
    setError(null);
    try {
      const data = await mutation.mutateAsync({
        sessionId: sourceSessionId,
        message_id: message.id,
        request_id: requestId,
      });
      requests.current.delete(key);
      if (originView !== null && view.current === originView) onCreated(data.session.id);
    } catch (failure) {
      if (originView !== null && view.current === originView) {
        const code = (failure as { code?: string }).code;
        setError({
          sessionId: sourceSessionId,
          messageId: message.id,
          text:
            code === 'branch_not_allowed'
              ? '这条回复暂时不能开启分支，请刷新后再试。'
              : code === 'branch_rate_limited'
                ? '操作有点快，稍等一下再试。'
                : '分支暂时没能打开，再点一次即可重试。',
        });
      }
    } finally {
      inFlight.current = false;
      if (view.current !== null) setPending(null);
    }
  };

  return {
    fork,
    leaveView,
    creating: pending?.sessionId === sessionId,
    pendingMessageId: pending?.sessionId === sessionId ? pending.messageId : null,
    error: error?.sessionId === sessionId ? error : null,
  };
}
