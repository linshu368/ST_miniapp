'use client';

import type { GetLatestUserChatData, GetUserChatsData } from '@miniapp/shared';
import { apiClient } from './client';

export async function fetchUserChats(): Promise<GetUserChatsData> {
  return apiClient<GetUserChatsData>('/api/users/chats');
}

export async function fetchLatestUserChat(characterId: string): Promise<GetLatestUserChatData> {
  const search = new URLSearchParams({ characterId });
  return apiClient<GetLatestUserChatData>(`/api/users/chats/latest?${search.toString()}`);
}
