'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  toVoiceMap,
  useGenerateVoiceMutation,
  useSessionVoiceQuery,
  useVoiceConfigQuery,
} from '@/lib/api/voice';
import { redirectToRechargeFromError } from '@/lib/recharge-redirect';

export type ChatVoiceReadState = 'deferred' | 'loading' | 'error' | 'ready';

/** Missing data is not proof that a voice has never been generated. */
export function useChatVoice(
  sessionId: string | null,
  backgroundReady: boolean,
  returnTo: string,
  onError: (message: string) => void
) {
  const router = useRouter();
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  const enabled = backgroundReady || Boolean(sessionId && requestedFor === sessionId);
  const config = useVoiceConfigQuery(enabled);
  const records = useSessionVoiceQuery(sessionId ?? undefined, { enabled });
  const generation = useGenerateVoiceMutation(sessionId ?? undefined);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const submitting = useRef(false);
  const byMessage = useMemo(() => toVoiceMap(records.data), [records.data]);
  const readState: ChatVoiceReadState =
    config.isFetching || records.isFetching
      ? 'loading'
      : config.isError || records.isError
        ? 'error'
        : config.isSuccess && records.isSuccess
          ? 'ready'
          : enabled
            ? 'loading'
            : 'deferred';
  const load = () => {
    if (!sessionId || activeSession.current !== sessionId) return;
    setRequestedFor(sessionId);
    // Queries already running are shared. Retry only failed/missing reads, never a paid POST.
    if (config.isError) void config.refetch({ cancelRefetch: false });
    if (records.isError) void records.refetch({ cancelRefetch: false });
  };
  const generate = (messageId: string) => {
    if (readState !== 'ready') {
      load();
      return;
    }
    if (
      !sessionId ||
      activeSession.current !== sessionId ||
      submitting.current ||
      generation.isPending
    )
      return;
    if (byMessage.get(messageId)?.status === 'pending') return;
    submitting.current = true;
    generation.mutate(
      { messageId },
      {
        onError: (error) => {
          if (activeSession.current !== sessionId) return;
          if (redirectToRechargeFromError(router, error, returnTo)) return;
          const code = (error as { code?: string }).code;
          onError(
            code === 'CONFLICT'
              ? '这条回复正在生成语音'
              : code === 'VOICE_UNAVAILABLE'
                ? '语音暂时用不了'
                : '语音生成没能开始，请重试'
          );
        },
        onSettled: () => {
          submitting.current = false;
        },
      }
    );
  };
  return {
    config: config.data,
    byMessage,
    readState,
    load,
    generate,
    submittingMessageId: generation.isPending ? generation.variables?.messageId : undefined,
  };
}
