import { z } from 'zod';

import { VIP_EXPIRY_NOTIFICATION_KIND, VipReminderWindowSchema } from './vip.js';

export type NotificationScope = 'official' | 'personal';
export type NotificationCategory = 'announcement' | 'activity' | 'system' | 'interaction';

export const NotificationKindSchema = z.literal(VIP_EXPIRY_NOTIFICATION_KIND);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const VipExpiryNotificationMetadataSchema = z.object({
  reminder_window: VipReminderWindowSchema,
  observed_valid_until: z.string().min(1),
});
export type VipExpiryNotificationMetadata = z.infer<typeof VipExpiryNotificationMetadataSchema>;

export interface NotificationItem {
  id: string;
  scope: NotificationScope;
  category: NotificationCategory;
  title: string;
  body: string;
  published_at: string;
  created_at: string;
  is_read: boolean;
  kind?: NotificationKind | null;
  action_path?: string | null;
  metadata?: VipExpiryNotificationMetadata | null;
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

export interface GetNotificationDetailData {
  notification: NotificationItem;
}
