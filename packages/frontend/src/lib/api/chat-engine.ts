'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_CHAT_ENGINE_MODE,
  isChatEngineMode,
  type ChatEngineMode,
  type GetChatEngineData,
} from '@miniapp/shared';

import { apiClient } from './client';

export const chatEngineKeys = {
  mode: ['platform', 'chat-engine'] as const,
};

const CACHE_KEY = 'miniapp:chat-engine-mode';

/**
 * 上次读到的开关值。ST iframe 的挂载要等这个请求回来，冷启动多一个往返会直接
 * 记在首条消息耗时上；缓存让除首次以外的每次启动都能立刻拿到值，后台再校正。
 */
function readCachedMode(): GetChatEngineData | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const cached = window.localStorage.getItem(CACHE_KEY);
    return isChatEngineMode(cached) ? { mode: cached, degraded: false } : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedMode(mode: ChatEngineMode): void {
  try {
    window.localStorage.setItem(CACHE_KEY, mode);
  } catch {
    // 隐私模式下写不了，退化成每次启动都等一次请求。
  }
}

export interface ChatEngineState {
  /** 直接可用的模式；还没解析出来时是兜底的 ST */
  mode: ChatEngineMode;
  /**
   * 首次启动等第一次响应期间为 false。请求失败不算未解析——读不到开关时
   * ST 就是答案，否则接口一挂，整个 MiniApp 会停在等开关的状态里。
   */
  resolved: boolean;
}

/**
 * 聊天链路开关。
 *
 * 「读不到怎么办」只在这里回答一次：一律当 ST。调用方只有在「等一下更好」的地方
 * （比如列表要按模式选数据源）才看 resolved，其余直接用 mode。
 */
export function useChatEngine(): ChatEngineState {
  const { data, isError } = useQuery<GetChatEngineData>({
    queryKey: chatEngineKeys.mode,
    queryFn: () => apiClient<GetChatEngineData>('/api/platform/chat-engine'),
    initialData: readCachedMode,
    // 缓存只用来抢时间，不算新鲜：挂载后立刻回源，翻转开关不需要用户清缓存。
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    // 每多retry 一次，无缓存的首启就多等一次退避才能回落到 ST。
    retry: 1,
  });

  useEffect(() => {
    if (data) writeCachedMode(data.mode);
  }, [data]);

  return {
    mode: data?.mode ?? DEFAULT_CHAT_ENGINE_MODE,
    resolved: data !== undefined || isError,
  };
}
