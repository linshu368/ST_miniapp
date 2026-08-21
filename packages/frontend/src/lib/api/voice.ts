'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMessageVoiceData,
  GetSessionVoiceData,
  GetVoiceConfigData,
  MessageVoice,
  PatchVoiceConfigData,
  PatchVoiceConfigRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

export const voiceKeys = {
  config: ['voice-config'] as const,
  session: (sessionId: string) => ['voice', 'session', sessionId] as const,
};

/** 音色与播放倍速是用户级的，切会话不必重取 */
export function useVoiceConfigQuery(enabled = true) {
  return useQuery<GetVoiceConfigData>({
    queryKey: voiceKeys.config,
    enabled,
    queryFn: async () => apiClient<GetVoiceConfigData>('/api/v1/voice/config'),
    staleTime: 5 * 60 * 1000,
  });
}

export function usePatchVoiceConfigMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: PatchVoiceConfigRequest) =>
      apiClient<PatchVoiceConfigData>('/api/v1/voice/config', {
        method: 'PATCH',
        body: JSON.stringify(request),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<GetVoiceConfigData>(voiceKeys.config, data);
    },
  });
}

/**
 * 整段对话的语音，按会话整取。
 *
 * 生成是后台异步跑的，没有推送通道，只能轮询；有 pending 才轮询，
 * 全部收口后自动停下——否则每个开着的聊天页都会一直在打这个接口。
 */
export function useSessionVoiceQuery(sessionId: string | undefined) {
  return useQuery<GetSessionVoiceData>({
    queryKey: voiceKeys.session(sessionId ?? ''),
    enabled: Boolean(sessionId),
    queryFn: async () => {
      if (!sessionId) throw new Error('session id is required');
      return apiClient<GetSessionVoiceData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/voice`
      );
    },
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.audio.some((item) => item.status === 'pending') ? 2_000 : false,
  });
}

/** customText 为空 = 默认链路，由写稿模型从回复正文里挑台词 */
export interface GenerateVoiceInput {
  messageId: string;
  customText?: string;
}

/**
 * 受理生成。后端返回 202 + 一条 pending 记录，先塞进缓存让按钮立刻变成「生成中」，
 * 之后交给上面的轮询接管——不这样做的话，要等下一次轮询才有反馈，点下去像没反应。
 */
export function useGenerateVoiceMutation(sessionId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ messageId, customText }: GenerateVoiceInput) => {
      if (!sessionId) throw new Error('session id is required');
      return apiClient<CreateMessageVoiceData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
          messageId
        )}/voice`,
        {
          method: 'POST',
          ...(customText ? { body: JSON.stringify({ custom_text: customText }) } : {}),
        }
      );
    },
    onSuccess: (data) => {
      if (!sessionId) return;
      queryClient.setQueryData<GetSessionVoiceData>(voiceKeys.session(sessionId), (current) =>
        mergeAudio(current, data.audio)
      );
    },
    onError: () => {
      // 失败态由后端记录，重取一次拿准确的错误码，别让 UI 卡在「生成中」
      if (!sessionId) return;
      void queryClient.invalidateQueries({ queryKey: voiceKeys.session(sessionId) });
    },
  });
}

function mergeAudio(
  current: GetSessionVoiceData | undefined,
  next: MessageVoice
): GetSessionVoiceData {
  const rest = (current?.audio ?? []).filter((item) => item.message_id !== next.message_id);
  return { audio: [...rest, next] };
}

/** 按 message_id 建索引，消息列表渲染时按 id 直接取，不用每条都遍历一遍 */
export function toVoiceMap(data: GetSessionVoiceData | undefined): Map<string, MessageVoice> {
  return new Map((data?.audio ?? []).map((item) => [item.message_id, item]));
}
