// 对话领域的前后端共享契约（单一真相源）
// 规则：任何一方新增对外数据形状都必须先落这里才能被消费

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string; // ISO 8601
}

// 列表 / 抽屉用的精简结构
export interface SessionSummary {
  id: string;
  character_id: string;
  character_name: string;
  last_message_preview: string;
  last_message_at: string; // ISO 8601
}

// 对话页用的完整结构
export interface SessionDetail {
  id: string;
  character_id: string;
  messages: Message[];
}

// GET /api/sessions 的响应体
export interface GetSessionsData {
  sessions: SessionSummary[];
}

// GET /api/sessions/:id 的响应体
export interface GetSessionDetailData {
  session: SessionDetail;
}

// POST /api/sessions/:id/messages 的请求 / 响应
export interface PostMessageRequest {
  content: string;
}
export interface PostMessageData {
  message: Message;
}

// POST /api/sessions/:id/messages 的 SSE event stream payload
export interface StreamChunkData {
  content?: string;
  error?: string;
}

// POST /api/sessions/open 请求 / 响应
// 语义：给定 character_id，返回该角色的最近 session；没有则创建新的
export interface PostOpenSessionRequest {
  character_id: string;
}
export interface PostOpenSessionData {
  session_id: string;
}
