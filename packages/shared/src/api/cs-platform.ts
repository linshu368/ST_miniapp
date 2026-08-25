export type CsPersonaStatus = 'active' | 'archived';

export type CsMembershipStatus = 'active' | 'chatted_left';

export type CsSessionStatus =
  | 'not_started'
  | 'icebreaking'
  | 'waiting_reply'
  | 'following_up'
  | 'completed'
  | 'snoozed'
  | 'skipped'
  | 'send_failed';

export type CsMessageDirection = 'agent' | 'user';

export type CsSendStatus = 'pending' | 'sent' | 'failed' | 'received';

/**
 * 等待回复状态，与 session_status 是两个维度：session_status 是 SOP 走到哪一步，
 * 这个只回答「这条会话该不该我现在处理」。
 *
 * first_round  用户发过消息、客服一句都还没成功发出去。列表标黄，必须优先处理。
 * second_round 客服至少成功回过一句，双方有来有回。列表标绿，正常跟进。
 * none         用户一句都没发过（含只发了破冰还没等到回复），不属于「等我回」。
 */
export type CsWaitingState = 'none' | 'first_round' | 'second_round';

/** 群发的状态筛选口径。all_waiting = 首轮 + 二次，all = 该簇全部用户 */
export type CsBroadcastAudience =
  | 'not_started'
  | 'first_round'
  | 'second_round'
  | 'all_waiting'
  | 'all';

export interface CsPersonaData {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  sql: string;
  opening_script: string;
  sop: CsSopStageData[];
  status: CsPersonaStatus;
  active_count: number;
  chatted_left_count: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CsSopStageData {
  key: string;
  title: string;
  prompt: string;
  followups?: string[];
  fallback_options?: string[];
}

export interface CsUserData {
  user_id: string;
  telegram_user_id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  register_days: number;
  total_paid_amount: string;
  paid_count: number;
  total_round: number;
  last_active_at: string | null;
  last_active_label: string;
  membership_status: CsMembershipStatus;
  session_status: CsSessionStatus;
  current_stage: string | null;
  chatted_at: string | null;
  left_note: string | null;
  /** 该用户在本簇里最后一条来信时间，中栏排序就按它倒序 */
  last_user_message_at: string | null;
  /** 客服最后一条成功送达的消息时间 */
  last_agent_message_at: string | null;
  waiting_state: CsWaitingState;
  /** 客服手写的特殊标记备注；null 或空串表示未标记 */
  special_note: string | null;
  special_note_updated_at: string | null;
}

export interface CsMessageData {
  id: string;
  persona_id: string;
  user_id: string;
  telegram_user_id: string;
  direction: CsMessageDirection;
  sop_stage: string | null;
  question_key: string | null;
  content: string;
  send_status: CsSendStatus;
  telegram_message_id: string | null;
  sent_at: string | null;
  received_at: string | null;
  failed_reason: string | null;
  created_at: string;
}

export interface CsSessionData {
  persona_id: string;
  user_id: string;
  status: CsSessionStatus;
  current_stage: string | null;
  current_question_key: string | null;
  next_touch_at: string | null;
  completed_at: string | null;
  skipped_at: string | null;
  skip_reason: string | null;
  suggested_prompt: string | null;
  available_actions: Array<'send' | 'advance' | 'snooze' | 'skip' | 'retry' | 'complete'>;
}

export interface GetCsPersonasData {
  personas: CsPersonaData[];
}

export interface CreateCsPersonaRequest {
  name: string;
  description?: string;
  color?: string;
  sql: string;
  opening_script: string;
  sop?: CsSopStageData[];
}

export interface UpdateCsPersonaRequest {
  name?: string;
  description?: string;
  color?: string;
  sql?: string;
  opening_script?: string;
  sop?: CsSopStageData[];
  status?: CsPersonaStatus;
}

export interface CsPersonaDataResponse {
  persona: CsPersonaData;
}

export interface DeleteCsPersonaData {
  persona: CsPersonaData;
}

export interface RefreshCsPersonaData {
  persona: CsPersonaData;
  run_id: string;
  active_count: number;
  entered_count: number;
  chatted_left_count: number;
  refreshed_at: string;
}

export interface GetCsPersonaUsersData {
  active: CsUserData[];
  chatted_left: CsUserData[];
}

export interface GetCsSessionData {
  session: CsSessionData;
}

export interface GetCsMessagesData {
  messages: CsMessageData[];
}

export interface CsAppChatTurnData {
  id: string;
  user_id: string;
  character_id: string | null;
  character_name: string | null;
  user_input: string;
  assistant_reply: string | null;
  model: string;
  status: 'success' | 'upstream_error' | 'stream_interrupted';
  created_at: string;
}

export interface GetCsAppChatData {
  turns: CsAppChatTurnData[];
}

export interface CsTelegramReachabilityData {
  reachable: boolean;
  reason: string | null;
}

export interface SendCsMessageRequest {
  content: string;
  sop_stage?: string;
  question_key?: string;
  idempotency_key?: string;
}

export interface SendCsMessageData {
  message: CsMessageData;
  session: CsSessionData;
}

export interface AdvanceCsSessionRequest {
  next_stage?: string;
  next_question_key?: string;
  status?: CsSessionStatus;
}

export interface SnoozeCsSessionRequest {
  next_touch_at?: string;
}

export interface SkipCsSessionRequest {
  reason?: string;
}

/** 备注是给客服自己看的一两句话，不是工单正文，给个上限防止误粘贴整段聊天 */
export const MAX_CS_SPECIAL_NOTE_CHARS = 500;

export interface SetCsSpecialNoteRequest {
  /** 空串或全空白 = 取消标记 */
  note: string;
}

export interface SetCsSpecialNoteData {
  user_id: string;
  persona_id: string;
  special_note: string | null;
  special_note_updated_at: string | null;
}

export interface CsBroadcastTargetPreview {
  user_id: string;
  display_name: string;
  waiting_state: CsWaitingState;
}

export interface CsBroadcastPreviewRequest {
  audience: CsBroadcastAudience;
}

export interface CsBroadcastPreviewData {
  audience: CsBroadcastAudience;
  /** 本次会触达的人数 */
  total: number;
  /** 前若干个对象，供客服确认发对了人；不是全量 */
  sample: CsBroadcastTargetPreview[];
}

export interface CsBroadcastRequest {
  audience: CsBroadcastAudience;
  content: string;
}

/**
 * 群发是提交即返回：几百个人要按 Telegram 限速一条条发，同步等完会超时。
 * accepted 是已排进队列的人数，逐条结果去回访记录里看。
 */
export interface CsBroadcastData {
  audience: CsBroadcastAudience;
  accepted: number;
}

export interface CsAuditLogData {
  id: string;
  operator_id: string;
  action: string;
  persona_id: string | null;
  user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface GetCsAuditLogsData {
  logs: CsAuditLogData[];
}
