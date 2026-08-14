// 自研引擎对话链路的前后端共享契约
// 方案：docs/ST_remove-MVP实施方案.md（§八 接口清单）
// 路由前缀 /api/v1/conversations 由 M3b 实现、M5 消费；鉴权统一走 requireTelegramAuth（X-Init-Data）

import type { PreferredWordCount } from './settings';
import type { PublicWordCountTiers } from './word-count-tiers';

// ==== 领域对象 ====

export type ChatMessageRole = 'user' | 'assistant';

export type ChatMessageStatus = 'streaming' | 'complete' | 'interrupted' | 'failed';

export interface ChatMessage {
  id: string;
  session_id: string;
  /** 用户主动发起的逻辑轮次从 1 递增；开场白是 API 虚拟消息，使用 turn_index = 0 */
  turn_index: number;
  role: ChatMessageRole;
  /** 重生成版本号：一轮的 user/assistant 投影共用 revision，最大 revision 是当前版本 */
  revision: number;
  content: string;
  status: ChatMessageStatus;
  error_code: string | null;
  finish_reason: string | null;
  /** 生成时的模型快照，仅 assistant 消息有值。改配置后历史输出仍可解释（总方案决策 10） */
  model_id: string | null;
  created_at: string;
}

export interface ChatSession {
  id: string;
  character_id: string;
  /** null = 用户未重命名，前端按首条用户消息截断显示；重命名后为实值 */
  title: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  message_count: number;
  /** null = 未置顶。置顶会话排在列表最前，多个置顶之间按此时间倒序 */
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 用户级生成配置：对该用户所有会话生效，不做会话级覆盖（总方案决策 10）。
 * 全部落在 miniapp.miniapp_user_settings 的既有字段上，M1 只建读取通道、不新增列。
 */
export interface UserGenerationConfig {
  /**
   * 用户存下来的模型选择原值，null = 从未选过。
   * 生效模型由生成侧的 resolveModel 在目录里做一次回退解析（与 llm-proxy 同一套口径），
   * 这里刻意不提前替换成默认值，否则「用户选过」与「回退到默认」两种状态无法区分。
   */
  selected_model_id: string | null;
  pref_word_count: PreferredWordCount;
  pref_show_options: boolean;
  pref_custom_instructions: string | null;
}

/**
 * 本域的业务错误码，配合 envelope 的 fail(code, message) 使用。
 * 余额不足与并发占用在 SSE 首字节写出之前判定，所以仍以 HTTP 状态码返回 JSON 错误体，
 * 不会以 stream 事件的形式出现。
 */
export type ConversationErrorCode =
  | 'session_not_found'
  | 'character_not_found'
  /** 409：该会话已有一条 status='streaming' 的 assistant 消息尚未收口 */
  | 'session_busy'
  /** 402：余额不足，响应体形状见 models.ts 的 InsufficientBalanceErrorResponse */
  | 'insufficient_balance'
  /** 只允许对最后一轮重生成，且该轮必须含 user 消息（本轮决策 5） */
  | 'regenerate_not_allowed'
  | 'upstream_error';

// ==== POST /api/v1/conversations ====

export interface CreateConversationRequest {
  character_id: string;
}

export interface CreateConversationData {
  session: ChatSession;
  /** 开场白是未单独落库的虚拟 turn 0；首轮生成后保存在 chat_history.history 快照中 */
  messages: ChatMessage[];
}

// ==== GET /api/v1/conversations ====

export interface ListConversationsQuery {
  /** 传入则只返回该角色下的会话；不传返回跨角色的全部会话 */
  character_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * 列表恒定过滤掉 message_count = 0 的会话：进角色卡就会建会话，一句话没发的那些
 * 不是历史记录，露出来只会让列表堆满「新的对话 / 0 条」。
 * 会话仍然存在，发出第一句后自动出现在列表里。
 */

export interface ListConversationsData {
  sessions: ChatSession[];
  total: number;
}

// ==== GET /api/v1/conversations/:id ====

export interface GetConversationQuery {
  limit?: number;
  /** 向前翻页：只取 turn_index 小于该值的消息 */
  before_turn_index?: number;
}

export interface GetConversationData {
  session: ChatSession;
  /** 按 turn_index 升序，同轮内 user 在前 assistant 在后 */
  messages: ChatMessage[];
  has_more: boolean;
}

// ==== PATCH /api/v1/conversations/:id ====

/**
 * 两个字段都可选：只传 title 是重命名，只传 pinned 是置顶/取消置顶，都不传是空操作。
 * title = null 是有意义的取值（清空为自动命名），所以「本次不改标题」只能用
 * 「不带 title 字段」表达，不能用 null 兼任。
 */
export interface UpdateConversationRequest {
  title?: string | null;
  pinned?: boolean;
}

export interface UpdateConversationData {
  session: ChatSession;
}

// ==== DELETE /api/v1/conversations/:id ====

/** 软删（本轮决策 4）：会话不再出现在列表，chat_history 的关联行仍可查 */
export interface DeleteConversationData {
  id: string;
}

// ==== POST /api/v1/conversations/:id/messages ====
// ==== POST /api/v1/conversations/:id/regenerate ====

export interface SendMessageRequest {
  content: string;
}

/** 重生成只作用于最后一轮，轮次由后端判定，无需入参 */
export type RegenerateRequest = Record<string, never>;

// ==== SSE 事件契约 ====
// 上面两条路由的响应体是 text/event-stream，每个 data: 行是一个序列化后的
// ConversationStreamEvent；没有 [DONE] 哨兵，终态是 done 事件。
// 客户端实现在 frontend/src/lib/api/conversation-stream.ts。原来的 apiStreamClient()
// 与本契约不兼容（按 OpenAI 风格解析 { content } 分片、认 [DONE]、回调累积全文，
// 且对非 2xx 只抛状态码、丢掉 402 响应体里的两个金额），已随 M5 一并删除。

/**
 * 首帧：上游接受本次生成（预检通过 + 上游 2xx）后立刻下发，早于第一个 token，
 * 让前端拿到落库后的 id 就能挂上占位气泡。
 * 在它之前失败的判定（402 / 409 / 上游拒绝）一律走 HTTP 状态码 + JSON 错误体。
 * user_message_id 在重生成时为 null（该轮的 user 消息早已存在）。
 */
export interface ConversationStreamStartEvent {
  type: 'start';
  turn_index: number;
  user_message_id: string | null;
  assistant_message_id: string;
  revision: number;
}

/** 增量：text 是本次新增的片段，不是累积全文 */
export interface ConversationStreamDeltaEvent {
  type: 'delta';
  text: string;
}

/**
 * 终态：流正常收口或被上游截断都会下发。
 * 客户端断开不会终止后端流程，后端仍跑到 [DONE] 并落库完整内容。
 */
export interface ConversationStreamDoneEvent {
  type: 'done';
  assistant_message_id: string;
  status: ChatMessageStatus;
  finish_reason: string | null;
}

/** 流已开始后才发生的错误。开始之前的失败一律走 HTTP 状态码 + JSON 错误体 */
export interface ConversationStreamErrorEvent {
  type: 'error';
  code: ConversationErrorCode;
  message: string;
}

export type ConversationStreamEvent =
  | ConversationStreamStartEvent
  | ConversationStreamDeltaEvent
  | ConversationStreamDoneEvent
  | ConversationStreamErrorEvent;

// ==== GET /api/v1/generation-config ====

export interface GetGenerationConfigData {
  config: UserGenerationConfig;
  /** 当前启用的回复长度档位，驱动 MiniApp「生成偏好」按钮文案与布局 */
  word_count_tiers: PublicWordCountTiers;
}

// ==== PATCH /api/v1/generation-config ====

/**
 * 只收三个 pref_* 字段。selected_model_id 是只读镜像，改模型走 POST /api/v1/models/select——
 * 那条路由带着「切到付费模型前先查余额」的业务闸门，从这里旁路改会绕过它。
 */
export interface PatchGenerationConfigRequest {
  pref_word_count?: PreferredWordCount;
  pref_show_options?: boolean;
  pref_custom_instructions?: string | null;
}

export interface PatchGenerationConfigData {
  config: UserGenerationConfig;
  word_count_tiers: PublicWordCountTiers;
}
