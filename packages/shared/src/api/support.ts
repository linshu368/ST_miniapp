export interface SupportMessage {
  id: string;
  sender: 'user' | 'agent';
  /** 只发图时为空字符串 */
  body: string;
  /** 客服服务给的签名图片地址，可直接用于 <img>；没有图片时为 null，旧接口不返回 */
  image_url?: string | null;
  client_msg_id: string | null;
  created_at: string;
}

export interface SupportConversation {
  id: string;
  status: 'open' | 'resolved';
  messages: SupportMessage[];
}

export interface GetSupportConversationData {
  conversation: SupportConversation | null;
}

/** 客服消息附带的图片上限；前端超过就先压缩 */
export const MAX_SUPPORT_IMAGE_BYTES = 3 * 1024 * 1024;

/** 文字和图片至少有一个 */
export interface SendSupportMessageRequest {
  body: string;
  client_msg_id: string;
  /** base64 编码的图片原始内容（不带 data: 前缀）；类型由客服服务按文件头识别 */
  image?: { data_base64: string };
}

export interface SendSupportMessageData {
  message: SupportMessage;
}

export interface GetSupportMessagesData {
  messages: SupportMessage[];
}

/** 客服回复的未读态只有有无之分，不展示条数。 */
export interface SupportUnreadData {
  has_unread: boolean;
}

export interface CsSupportConversationSummary {
  id: string;
  user_id: string;
  telegram_user_id: string;
  display_name: string | null;
  status: 'open' | 'resolved';
  agent_unread_count: number;
  last_user_message_at: string | null;
  last_agent_message_at: string | null;
  last_message: string | null;
}

export interface GetCsSupportConversationsData {
  conversations: CsSupportConversationSummary[];
}

export interface GetCsSupportMessagesData {
  conversation: CsSupportConversationSummary;
  messages: SupportMessage[];
}

export interface SendCsSupportMessageRequest {
  body: string;
}

/** 主 Bot → 独立客服群收件；只收件，不创建私聊或触发 SOP。 */
export interface TelegramGroupMessageInput {
  bot_source?: 'main';
  chat_id: string;
  chat_title?: string;
  message_id: string;
  /** sender_chat 代发时不能使用 Telegram 兼容字段 from 中的假用户。 */
  telegram_user_id: string | null;
  sender_name: string;
  is_bot: boolean;
  text: string;
  sent_at: string;
  reply_to_message_id?: string | null;
  photo_file_id?: string | null;
  edited?: boolean;
  edited_at?: string | null;
  sender_chat_id?: string | null;
  message_thread_id?: string | null;
}
