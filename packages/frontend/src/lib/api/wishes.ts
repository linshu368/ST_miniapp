'use client';

import { useMutation } from '@tanstack/react-query';
import type {
  CompleteWishRoleData,
  CompleteWishRoleRequest,
  CreateWishRoleData,
  CreateWishRoleRequest,
} from '@miniapp/shared';

import { apiClient } from './client';

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

export function useCreateWishMutation() {
  return useMutation<CreateWishRoleData, Error, CreateWishRoleRequest>({
    mutationFn: postCreateWish,
  });
}

export function useCompleteWishMutation() {
  return useMutation<CompleteWishRoleData, Error, { id: string; body: CompleteWishRoleRequest }>({
    mutationFn: postCompleteWish,
  });
}
