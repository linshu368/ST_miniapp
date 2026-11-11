export const STREAMING_STALE_SECONDS = 120;
import type { LlmModelProvider } from '@miniapp/shared';
import type { InstructionSlotModes } from '../../features/engine/types.js';
import type { StoryTurn } from '../../features/story-memory/text.js';

export interface ConversationHistoryRow {
  user_deleted?: boolean;
  assistant_deleted?: boolean;
  user_edit_version?: number;
  assistant_edit_version?: number;
  is_inherited?: boolean;
  liked?: boolean;
  first_token_preview?: { kind: 'delta' | 'reasoning'; text: string } | null;
  id: string;
  user_id: string;
  model: string;
  user_input: string;
  assistant_reply: string | null;
  history?: unknown[];
  display_request_id?: string | null;
  display_opening_message?: string | null;
  display_fallback?: boolean;
  character_id: string | null;
  status: string;
  upstream_status: number | null;
  deduction_rate: number | null;
  created_at: string;
  llm_finish_reason: string | null;
  llm_charge_id: string | null;
  llm_billing_snapshot: LlmBillingSnapshot | null;
  llm_billing_settled_at: string | null;
  session_id: string;
  turn_index: number;
  revision: number;
  /** 迁移未执行时视图没有这一列。缺失按 null，不用当前配置顶上。 */
  postprocess_version?: number | null;
  rich_reply_metadata?: unknown;
}

export interface CreatorRewardSnapshot {
  character_id: string;
  creator_user_id: string;
  rate: 0.4;
  wallet: 'bonus';
  policy_version: 1;
}

/** 请求时定价快照。回捞按此重建 charge，不重新定价。 */
export interface LlmBillingSnapshot {
  charge_id: string;
  model_id: string | null;
  provider?: LlmModelProvider;
  provider_model_id?: string;
  model_display_name: string;
  model_markup: number;
  fixed_deduction: number;
  fixed_deduction_category: string;
  catalog_version: number;
  pricing_config_version: number;
  exchange_rate: number;
  billing_mode: 'fixed_tier';
  original_credits?: number;
  discount_rate?: number | null;
  discounted_exact?: number;
  payable_credits?: number;
  wallet_policy?: 'main_only' | 'main_then_bonus';
  requires_vip?: boolean;
  vip_active?: boolean;
  vip_valid_until?: string | null;
  model_tier?: string | null;
  vip_discount_config_version?: number | null;
  creator_reward?: CreatorRewardSnapshot;
}

export interface ChatHistorySyncRow {
  id: string;
  user_id: string;
  model: string;
  generationId: string | null;
  callProvider: LlmModelProvider | null;
  session_id?: string;
  llm_finish_reason: string | null;
  llm_charge_id: string | null;
  assistant_reply: string | null;
  status: string;
  llm_billing_snapshot: LlmBillingSnapshot | null;
  llm_billing_settled_at: string | null;
}

export interface StartedHistoryTurn {
  turnIndex: number;
  historyId: string;
  revision: number;
  userContent: string;
  contextWindowStartTurn: number;
  /** current-version RPC 实际写入的非空正式版本。 */
  postprocessVersion: number;
  /** Immutable modes chosen by the same database transaction that created this revision. */
  slotModes: InstructionSlotModes;
}

export interface ConversationContext {
  /** 首轮实际 prompt 中保存的开场白；尚无历史时为 null，由调用方使用角色卡当前 first_mes */
  openingMessage: string | null;
  messages: ConversationContextMessage[];
  /** Ascending context turns used by the upstream story-memory watermarks. */
  turns: StoryTurn[];
  /** 被窗口截掉的早期轮数 = context_window_start_turn - 1；未截断为 0 */
  truncatedTurns: number;
}

export type ConversationContextMessage = { role: 'user' | 'assistant'; content: string };
