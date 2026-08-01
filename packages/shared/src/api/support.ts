export interface SupportMessage {
  id: string;
  sender: 'user' | 'agent';
  body: string;
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

export interface SendSupportMessageRequest {
  body: string;
  client_msg_id: string;
}

export interface SendSupportMessageData {
  message: SupportMessage;
}

export interface GetSupportMessagesData {
  messages: SupportMessage[];
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
