'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DramaDetail,
  DramaPlayback,
  DramaSummary,
  GetDramaByIdData,
  GetDramaPlaybackData,
  GetDramasData,
} from '@miniapp/shared';

import { apiClient } from './client';
import { dramaTiming } from '@/lib/perf/drama-observer';

export const dramaKeys = {
  all: ['dramas'] as const,
  list: () => [...dramaKeys.all, 'list'] as const,
  browseQueue: () => [...dramaKeys.all, 'browse-queue'] as const,
  detail: (id: string) => [...dramaKeys.all, 'detail', id] as const,
  playback: (id: string, videoId?: string) =>
    [...dramaKeys.all, 'playback', id, videoId ?? null] as const,
};

async function fetchDramas(kind: 'list' | 'queue' = 'list'): Promise<DramaSummary[]> {
  return dramaTiming.query(kind, undefined, undefined, async (onAttempt) => {
    const data = await apiClient<GetDramasData>('/api/dramas', { onAttempt });
    return data.dramas;
  });
}

async function fetchDramaDetail(id: string): Promise<DramaDetail> {
  return dramaTiming.query('detail', id, undefined, async (onAttempt) => {
    const data = await apiClient<GetDramaByIdData>(`/api/dramas/${encodeURIComponent(id)}`, {
      onAttempt,
    });
    return data.drama;
  });
}

async function fetchDramaPlayback(id: string, videoId?: string): Promise<DramaPlayback> {
  const suffix = videoId ? `?video_id=${encodeURIComponent(videoId)}` : '';
  return dramaTiming.query('playback', id, videoId, async (onAttempt) => {
    const data = await apiClient<GetDramaPlaybackData>(
      `/api/dramas/${encodeURIComponent(id)}/play${suffix}`,
      { onAttempt }
    );
    return data.playback;
  });
}

// 保留结果对象身份，防止 structural sharing 把本次请求映射到旧对象的计时元数据。
export function useDramaListQuery() {
  return useQuery({
    queryKey: dramaKeys.list(),
    queryFn: () => fetchDramas(),
    structuralSharing: false,
  });
}

/** 换剧跨路由保留本轮列表顺序；深链没有列表缓存时才自行加载。 */
export function useDramaBrowseQueueQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: dramaKeys.browseQueue(),
    queryFn: () => fetchDramas('queue'),
    initialData: () => queryClient.getQueryData<DramaSummary[]>(dramaKeys.list()),
    staleTime: Infinity,
  });
}

export function useDramaDetailQuery(id: string) {
  return useQuery({
    queryKey: dramaKeys.detail(id),
    queryFn: () => fetchDramaDetail(id),
    structuralSharing: false,
    enabled: Boolean(id),
  });
}

/**
 * 不传 videoId 时后端按固定顺序返回第一条可播视频，所以首次播放不必等详情；
 * 换集时传目标 video id。签名链接有效期 1 小时，用全局默认 staleTime（30s）
 * 已明显短于 TTL，重新进入详情页即可拿到新链接，不需要单独调大/调小。
 */
export function useDramaPlaybackQuery(id: string, videoId?: string) {
  return useQuery({
    queryKey: dramaKeys.playback(id, videoId),
    queryFn: () => fetchDramaPlayback(id, videoId),
    structuralSharing: false,
    enabled: Boolean(id),
  });
}

/** 点击卡片时顺手预取首集播放地址，省掉路由跳转后再发请求的一小段延迟。 */
export function usePrefetchDramaPlayback() {
  const queryClient = useQueryClient();
  return (id: string, browseQueue?: DramaSummary[]) => {
    // 点击时固定当前筛选/排序后的队列，保证进入播放后的上下滑仍沿用所见顺序。
    const list = browseQueue ?? queryClient.getQueryData<DramaSummary[]>(dramaKeys.list());
    if (list) queryClient.setQueryData(dramaKeys.browseQueue(), list);
    void queryClient.prefetchQuery({
      queryKey: dramaKeys.playback(id),
      queryFn: () => fetchDramaPlayback(id),
      structuralSharing: false,
    });
  };
}
