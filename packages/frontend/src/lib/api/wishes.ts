'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompleteWishRoleData,
  CompleteWishRoleRequest,
  CreateWishRoleData,
  CreateWishRoleRequest,
  GetWishRoleStatusData,
} from '@miniapp/shared';

import { apiClient } from './client';

export const wishKeys = {
  all: ['wishes'] as const,
  status: () => [...wishKeys.all, 'status'] as const,
};

async function fetchWishStatus(): Promise<GetWishRoleStatusData> {
  return apiClient<GetWishRoleStatusData>('/api/wishes/status');
}

async function postCreateWish(body: CreateWishRoleRequest): Promise<CreateWishRoleData> {
  return apiClient<CreateWishRoleData>('/api/wishes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function postCompleteWish(input: {
  id: string;
  body: CompleteWishRoleRequest;
}): Promise<CompleteWishRoleData> {
  return apiClient<CompleteWishRoleData>(`/api/wishes/${encodeURIComponent(input.id)}/complete`, {
    method: 'POST',
    body: JSON.stringify(input.body),
  });
}

export function useWishStatusQuery() {
  return useQuery<GetWishRoleStatusData>({
    queryKey: wishKeys.status(),
    queryFn: fetchWishStatus,
    staleTime: 15_000,
  });
}

export function useCreateWishMutation() {
  const qc = useQueryClient();
  return useMutation<CreateWishRoleData, Error, CreateWishRoleRequest>({
    mutationFn: postCreateWish,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: wishKeys.status() });
    },
  });
}

export function useCompleteWishMutation() {
  const qc = useQueryClient();
  return useMutation<CompleteWishRoleData, Error, { id: string; body: CompleteWishRoleRequest }>({
    mutationFn: postCompleteWish,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: wishKeys.status() });
    },
  });
}
