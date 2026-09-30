'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ReadTextPostprocessVersionsDataSchema,
  type ChatMessage,
  type ReadTextPostprocessVersionsData,
} from '@miniapp/shared';

import { API_URL, apiClient } from './client';
import {
  collectPostprocessVersions,
  isSettledSnapshot,
  loadVersionSnapshots,
  textPostprocessCollectionKey,
  textPostprocessVersionKey,
  type VersionSnapshotState,
  type VersionStateMap,
} from '@/lib/text-postprocess/versions';

const VERSION_STALE_TIME_MS = Number.POSITIVE_INFINITY;
const VERSION_GC_TIME_MS = 24 * 60 * 60 * 1000;
const VERSION_TIMEOUT_MS = 5_000;

export async function postTextPostprocessVersions(
  versions: readonly number[]
): Promise<ReadTextPostprocessVersionsData> {
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(VERSION_TIMEOUT_MS)
      : undefined;
  const data = await apiClient<unknown>('/api/v1/text-postprocess/versions', {
    method: 'POST',
    body: JSON.stringify({ versions }),
    signal,
  });
  const parsed = ReadTextPostprocessVersionsDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('text postprocess version batch was rejected');
  }
  return parsed.data;
}

/**
 * 历史消息按版本集合批量取快照。已发布版本写入单独缓存，后续只补缺失编号。
 * 组件不直接 fetch。服务端预渲染不发请求，避免在模块加载时碰浏览器。
 */
export function useTextPostprocessVersions(messages: readonly ChatMessage[]): VersionStateMap {
  const client = useQueryClient();
  const versionKey = collectPostprocessVersions(messages).join(',');
  const versions = useMemo(
    () => (versionKey ? versionKey.split(',').map((item) => Number(item)) : []),
    [versionKey]
  );
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => {
    setClientReady(true);
  }, []);

  const query = useQuery({
    queryKey: textPostprocessCollectionKey(API_URL, versions),
    enabled: clientReady && versions.length > 0,
    staleTime: VERSION_STALE_TIME_MS,
    gcTime: VERSION_GC_TIME_MS,
    retry: 1,
    retryDelay: 250,
    queryFn: () =>
      loadVersionSnapshots({
        versions,
        readCached: (version) =>
          client.getQueryData<VersionSnapshotState>(textPostprocessVersionKey(API_URL, version)),
        writeCached: (version, state) => {
          client.setQueryData(textPostprocessVersionKey(API_URL, version), state);
        },
        postBatch: postTextPostprocessVersions,
      }),
  });

  return useMemo(() => {
    const states: Record<number, VersionSnapshotState> = {};
    for (const version of versions) {
      const fetched = query.data?.[version];
      if (fetched) {
        states[version] = fetched;
        continue;
      }
      const cached = client.getQueryData<VersionSnapshotState>(
        textPostprocessVersionKey(API_URL, version)
      );
      if (isSettledSnapshot(cached)) {
        states[version] = cached;
        continue;
      }
      states[version] = query.isError ? { status: 'error' } : { status: 'loading' };
    }
    return states;
  }, [client, query.data, query.isError, versions]);
}
