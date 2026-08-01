import type { SupportMessage } from '@miniapp/shared';

export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfDay.getTime()) / 86_400_000);

  if (dayDiff <= 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `昨天 ${clock}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface PendingSupportMessage {
  clientMsgId: string;
  body: string;
  status: 'sending' | 'failed';
}

/**
 * 服务端确认后同一条消息会同时存在于会话历史和本地待发列表里，
 * 按 client_msg_id 丢掉已确认的，避免气泡重复。
 */
export function pendingOutbox(
  pending: PendingSupportMessage[],
  confirmed: SupportMessage[]
): PendingSupportMessage[] {
  const confirmedIds = new Set(
    confirmed.map((message) => message.client_msg_id).filter((id): id is string => Boolean(id))
  );
  return pending.filter((item) => !confirmedIds.has(item.clientMsgId));
}
