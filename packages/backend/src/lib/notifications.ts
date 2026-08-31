import type { NotificationCategory } from '@miniapp/shared';
import { getDomainDb } from './supabase.js';

export async function insertUserNotification(input: {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getDomainDb('miniapp_features').from('notifications').insert({
    scope: 'personal',
    category: input.category,
    title: input.title.trim(),
    body: input.body.trim(),
    user_id: input.userId,
    is_published: true,
    published_at: now,
    created_at: now,
    updated_at: now,
  });
  if (error) throw new Error(`创建用户消息失败：${error.message}`);
}
