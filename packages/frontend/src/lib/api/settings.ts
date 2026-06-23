'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetUserSettingsData,
  PatchUserSettingsData,
  PatchUserSettingsRequest,
} from '@miniapp/shared';

import { apiClient } from './client';

export const userSettingsKeys = {
  all: ['user-settings'] as const,
};

async function fetchUserSettings(): Promise<GetUserSettingsData> {
  return apiClient<GetUserSettingsData>('/api/users/settings');
}

async function patchUserSettings(body: PatchUserSettingsRequest): Promise<PatchUserSettingsData> {
  return apiClient<PatchUserSettingsData>('/api/users/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function useUserSettingsQuery() {
  return useQuery<GetUserSettingsData>({
    queryKey: userSettingsKeys.all,
    queryFn: fetchUserSettings,
    staleTime: 60_000,
  });
}

export function usePatchUserSettingsMutation() {
  const qc = useQueryClient();
  return useMutation<PatchUserSettingsData, Error, PatchUserSettingsRequest>({
    mutationFn: patchUserSettings,
    onSuccess: (data) => {
      qc.setQueryData<GetUserSettingsData>(userSettingsKeys.all, {
        settings: data.settings,
      });
    },
  });
}
