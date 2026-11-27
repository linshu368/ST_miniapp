import { z } from 'zod';

import { VIP_EXPIRY_NOTIFICATION_KIND, VipReminderWindowSchema } from './vip.js';

export type NotificationScope = 'official' | 'personal';
export type NotificationCategory = 'announcement' | 'activity' | 'system' | 'interaction';

export const NotificationKindSchema = z.enum([
  VIP_EXPIRY_NOTIFICATION_KIND,
  'character_wish_response',
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const VipExpiryNotificationMetadataSchema = z.object({
  reminder_window: VipReminderWindowSchema,
  observed_valid_until: z.string().min(1),
});
export type VipExpiryNotificationMetadata = z.infer<typeof VipExpiryNotificationMetadataSchema>;

export const CharacterWishNotificationMetadataSchema = z.object({
  wish_id: z.string().uuid(),
  character_id: z.string().uuid(),
});
export type CharacterWishNotificationMetadata = z.infer<
  typeof CharacterWishNotificationMetadataSchema
>;

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
  metadata?: VipExpiryNotificationMetadata | CharacterWishNotificationMetadata | null;
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
 * 发布超过 14 天的消息一律视为已读：不计未读数、列表 is_read 为 true，前端收进「更早」。
 * 前后端共用这一条判断，红点和列表才不会对不上。
 */
export const NOTIFICATION_UNREAD_WINDOW_MS = 14 * 86_400_000;

export function isOutsideNotificationUnreadWindow(publishedAt: string, nowMs: number): boolean {
  const published = Date.parse(publishedAt);
  return Number.isFinite(published) && published < nowMs - NOTIFICATION_UNREAD_WINDOW_MS;
}

/**
 * 两种写法：
 * - `ids`：只把这些 id 标已读；同时带 scope 时再限制到该分类。只传 scope 不会全部已读。
 * - `scope` + `all: true`（不能带 ids）：把该分类 14 天窗口内的未读全部标已读。
 */
export interface MarkNotificationsReadRequest {
  scope?: NotificationScope;
  ids?: string[];
  all?: true;
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
