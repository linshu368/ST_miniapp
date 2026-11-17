import type { SupabaseClient } from '@supabase/supabase-js';

export type AnnouncementCategory = 'announcement' | 'activity' | 'system' | 'interaction';

export interface Announcement {
  id: string;
  scope: 'official';
  category: AnnouncementCategory;
  title: string;
  body: string;
  sort_order: number;
  is_published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('公告接口没有返回数据');
  return data;
}

export async function listAnnouncements(client: SupabaseClient): Promise<Announcement[]> {
  const { data, error } = await client.schema('admin').rpc('list_announcements');
  return unwrap((data ?? []) as Announcement[], error);
}

export async function createAnnouncement(input: {
  client: SupabaseClient;
  category: AnnouncementCategory;
  title: string;
  body: string;
  sortOrder: number;
  isPublished: boolean;
}): Promise<Announcement> {
  const { data, error } = await input.client.schema('admin').rpc('create_announcement', {
    p_category: input.category,
    p_title: input.title,
    p_body: input.body,
    p_sort_order: input.sortOrder,
    p_is_published: input.isPublished,
  });
  return unwrap(data as Announcement | null, error);
}

export async function updateAnnouncement(input: {
  client: SupabaseClient;
  id: string;
  category: AnnouncementCategory;
  title: string;
  body: string;
  sortOrder: number;
}): Promise<Announcement> {
  const { data, error } = await input.client.schema('admin').rpc('update_announcement', {
    p_id: input.id,
    p_category: input.category,
    p_title: input.title,
    p_body: input.body,
    p_sort_order: input.sortOrder,
  });
  return unwrap(data as Announcement | null, error);
}

export async function setAnnouncementPublished(
  client: SupabaseClient,
  id: string,
  isPublished: boolean
): Promise<Announcement> {
  const { data, error } = await client.schema('admin').rpc('set_announcement_published', {
    p_id: id,
    p_is_published: isPublished,
  });
  return unwrap(data as Announcement | null, error);
}

export async function deleteAnnouncement(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.schema('admin').rpc('delete_announcement', { p_id: id });
  if (error) throw new Error(error.message);
}
