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
  is_pinned?: boolean; // 置顶。true 时排到列表顶部,在置顶组内按 last_message_at 倒序
  custom_name?: string; // 用户自定义名(改名后非空)。前端展示优先 custom_name → character_name
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
  /** 客户端生成的消息幂等键，网络重试时保持不变可避免重复扣费 */
  client_message_id?: string;
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
// 语义：给定 character_id，永远为其创建一个新 session(不复用现存 session)。
// 用户从大厅角色卡进入 = 想开始一段新对话；要继续旧对话走侧边栏。
export interface PostOpenSessionRequest {
  character_id: string;
}
export interface PostOpenSessionData {
  session_id: string;
}

// PATCH /api/sessions/:id
export interface PatchSessionRequest {
  custom_name?: string; // 传空字符串 "" 视为清除自定义名
  is_pinned?: boolean; // true/false 切换置顶
}
export interface PatchSessionData {
  session: SessionSummary;
}

// DELETE /api/sessions/:id
export interface DeleteSessionData {
  session_id: string;
}
