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
