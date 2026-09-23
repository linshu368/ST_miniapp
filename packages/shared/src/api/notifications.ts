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

export const VIP_EXPIRY_REMINDER_ACTION_PATH = '/vip' as const;

/** 标题是固定产品文案，不进入 Admin。正文由数据库按发送时的上海日期生成。 */
export const VIP_EXPIRY_REMINDER_TITLES: Record<z.infer<typeof VipReminderWindowSchema>, string> = {
  expiring_soon: 'VIP 即将到期',
  expires_today: 'VIP 今日到期',
};

export function vipExpiryReminderBody(
  window: z.infer<typeof VipReminderWindowSchema>,
  shanghaiDate: string
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shanghaiDate)) {
    throw new Error('vip reminder date must be YYYY-MM-DD');
  }
  if (window === 'expiring_soon') {
    return `您的 VIP 将于 ${shanghaiDate}（北京时间）到期。`;
  }
  return `您的 VIP 于 ${shanghaiDate}（北京时间）到期。`;
}

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

/**
 * 只有 ids 会写入已读。只传 scope 不会把该分类全部标已读。
 * scope 与 ids 同时出现时，只把这些 id 再限制到该分类。
 */
export interface MarkNotificationsReadRequest {
  scope?: NotificationScope;
  ids?: string[];
}

export interface MarkNotificationsReadData {
  marked: number;
}

/**
 * 详情只返回发送时的通知事实。当前会员状态走 GET /api/vip/status，
 * 续费后的实时状态不能回写这条历史正文。
 */
export interface GetNotificationDetailData {
  notification: NotificationItem;
}
