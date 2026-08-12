'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isChatEngineMode, type ChatEngineMode, type GetChatEngineData } from '@miniapp/shared';

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

function useChatEngineQuery() {
  return useQuery<GetChatEngineData>({
    queryKey: chatEngineKeys.mode,
    queryFn: () => apiClient<GetChatEngineData>('/api/platform/chat-engine'),
    initialData: readCachedMode,
    // 缓存只用来抢时间，不算新鲜：挂载后立刻回源，翻转开关不需要用户清缓存。
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
  });
}

/**
 * 聊天链路开关。undefined = 还没解析出来（首次启动或请求失败）。
 *
 * 调用方对 undefined 一律按旧链路处理：读不到开关时保持 ST 是安全的，
 * 反过来会把用户送进一个后端可能还没准备好的链路。
 */
export function useChatEngineMode(): ChatEngineMode | undefined {
  const { data } = useChatEngineQuery();

  useEffect(() => {
    if (data) writeCachedMode(data.mode);
  }, [data]);

  return data?.mode;
}
