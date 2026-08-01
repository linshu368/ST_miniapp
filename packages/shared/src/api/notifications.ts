export type NotificationScope = 'official' | 'personal';
export type NotificationCategory = 'announcement' | 'activity' | 'system' | 'interaction';

export interface NotificationItem {
  id: string;
  scope: NotificationScope;
  category: NotificationCategory;
  title: string;
  body: string;
  published_at: string;
  created_at: string;
  is_read: boolean;
}

export interface GetNotificationsData {
  notifications: NotificationItem[];
  next_cursor: string | null;
}

export interface NotificationUnreadCountData {
  official: number;
  personal: number;
  total: number;
}

export interface MarkNotificationsReadRequest {
  scope?: NotificationScope;
  ids?: string[];
}

export interface MarkNotificationsReadData {
  marked: number;
}
