'use client';

import type { GetUserChatsData } from '@miniapp/shared';
import { apiClient } from './client';

export async function fetchUserChats(): Promise<GetUserChatsData> {
  return apiClient<GetUserChatsData>('/api/users/chats');
}
