'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DramaSurveyStatusDataSchema,
  SubmitDramaSurveyDataSchema,
  type DismissDramaSurveyRequest,
  type DramaSurveyStatusData,
  type SubmitDramaSurveyData,
  type SubmitDramaSurveyRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

const PATH = '/api/v1/drama-survey';
const statusKey = ['drama-survey', 'status'] as const;

/** 只在满足弹出条件后才启用；结果在本次页面生命周期内不再刷新。 */
export function useDramaSurveyStatusQuery(enabled: boolean) {
  return useQuery({
    queryKey: statusKey,
    enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: async () =>
      DramaSurveyStatusDataSchema.parse(
        await apiClient<DramaSurveyStatusData>(PATH, { timeoutMs: 8_000 })
      ),
  });
}

export function useSubmitDramaSurveyMutation() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (body: SubmitDramaSurveyRequest) =>
      SubmitDramaSurveyDataSchema.parse(
        await apiClient<SubmitDramaSurveyData>(PATH, {
          method: 'POST',
          body: JSON.stringify(body),
          timeoutMs: 10_000,
        })
      ),
    onSuccess: (data) => {
      client.setQueryData(statusKey, (current: DramaSurveyStatusData | undefined) =>
        current ? { ...current, eligible: false } : current
      );
      if (data.status === 'rewarded') void client.invalidateQueries({ queryKey: ['wallet'] });
    },
  });
}

/** 叉掉记录只用于算回答率，失败不重试、不提示。 */
export function useDismissDramaSurveyMutation() {
  return useMutation({
    retry: false,
    mutationFn: (body: DismissDramaSurveyRequest) =>
      apiClient<{ dismissed: boolean }>(`${PATH}/dismiss`, {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 8_000,
      }),
  });
}
