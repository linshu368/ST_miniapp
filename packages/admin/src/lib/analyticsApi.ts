import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnalyticsSectionKey } from './adminNavigation';

export type AnalyticsGrain = 'hour' | 'day' | 'week' | 'month';
export type AnalyticsRow = Record<string, unknown>;

export interface AnalyticsSummary {
  label: string;
  value: number | string | null;
  unit?: string;
}

export interface AnalyticsChart {
  title: string;
  type: 'line' | 'column';
  data: Array<{
    bucket: string;
    metric: string;
    value: number;
  }>;
}

export interface AnalyticsTable {
  title: string;
  rows: AnalyticsRow[];
}

export interface AnalyticsDashboard {
  section: AnalyticsSectionKey;
  from: string;
  to: string;
  grain: AnalyticsGrain;
  summary: AnalyticsSummary[];
  charts: AnalyticsChart[];
  tables: AnalyticsTable[];
  notes: string[];
  generated_at: string;
}

export interface AnalyticsQuery {
  from: string;
  to: string;
  grain: AnalyticsGrain;
}

export interface AnalyticsUser {
  user_id: string;
  tg_id: string;
  tg_username: string | null;
  display_name: string | null;
  source_id: string | null;
  created_at: string;
  miniapp_entered_at: string | null;
  st_initialized_at: string | null;
  total_round: number;
  total_credits: number;
  total_paid_amount: number;
  last_active_at: string | null;
}

export interface AnalyticsChat {
  id: string;
  user_id: string;
  tg_id: string;
  display_name: string | null;
  character_name: string | null;
  model: string;
  provider: string | null;
  status: string;
  upstream_status: number | null;
  deduction_rate: number;
  llm_latency: number | null;
  llm_generation_time: number | null;
  user_input_preview: string;
  assistant_reply_preview: string;
  created_at: string;
}

export interface AnalyticsOutreachMessage {
  id: string;
  persona_name: string | null;
  user_id: string;
  telegram_user_id: string;
  direction: string;
  sop_stage: string | null;
  question_key: string | null;
  content: string;
  send_status: string;
  failed_reason: string | null;
  operator_id: string | null;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
}

export interface AnalyticsUsageCharge {
  id: string;
  charge_key: string;
  generation_id: string | null;
  user_id: string;
  tg_id: string;
  display_name: string | null;
  model_id: string | null;
  model_openrouter_id: string;
  model_display_name: string;
  catalog_version: number;
  pricing_config_version: number;
  usage_cost_usd: number | null;
  exchange_rate: number;
  model_markup: number;
  initial_amount: number;
  calculated_amount: number;
  charged_amount: number;
  fallback_used: boolean;
  status: string;
  debit_ledger_id: string | null;
  created_at: string;
  updated_at: string;
  reconciled_at: string | null;
  total_count: number;
}

export interface AnalyticsUsageChargeFilters {
  search: string;
  model: string;
  fallback: boolean | null;
  status: string;
}

export interface CharacterFavoriteLeaderboardRow {
  rank: number;
  character_id: string;
  character_name: string;
  enabled: boolean;
  favorite_count: number;
  new_favorite_count: number;
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('数据分析接口没有返回数据');
  return data;
}

export async function getAnalyticsDashboard(
  client: SupabaseClient,
  section: AnalyticsSectionKey,
  query: AnalyticsQuery
): Promise<AnalyticsDashboard> {
  const { data, error } = await client.schema('admin').rpc('get_analytics_dashboard', {
    p_section: section,
    p_from: query.from,
    p_to: query.to,
    p_grain: query.grain,
  });
  return unwrap(data as AnalyticsDashboard | null, error);
}

export async function listAnalyticsUsers(
  client: SupabaseClient,
  search: string,
  page: number,
  pageSize: number
): Promise<AnalyticsUser[]> {
  const { data, error } = await client.schema('admin').rpc('list_analytics_users', {
    p_search: search || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  return unwrap((data ?? []) as AnalyticsUser[], error);
}

export async function getAnalyticsUserDetail(
  client: SupabaseClient,
  userId: string
): Promise<AnalyticsRow> {
  const { data, error } = await client
    .schema('admin')
    .rpc('get_analytics_user_detail', { p_user_id: userId });
  return unwrap(data as AnalyticsRow | null, error);
}

export async function listAnalyticsChats(
  client: SupabaseClient,
  query: AnalyticsQuery,
  search: string,
  status: string,
  page: number,
  pageSize: number
): Promise<AnalyticsChat[]> {
  const { data, error } = await client.schema('admin').rpc('list_analytics_chats', {
    p_from: query.from,
    p_to: query.to,
    p_search: search || null,
    p_status: status || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  return unwrap((data ?? []) as AnalyticsChat[], error);
}

export async function getAnalyticsChatDetail(
  client: SupabaseClient,
  chatId: string
): Promise<AnalyticsRow> {
  const { data, error } = await client
    .schema('admin')
    .rpc('get_analytics_chat_detail', { p_chat_id: chatId });
  return unwrap(data as AnalyticsRow | null, error);
}

export async function listAnalyticsOutreachMessages(
  client: SupabaseClient,
  query: AnalyticsQuery,
  search: string,
  status: string,
  page: number,
  pageSize: number
): Promise<AnalyticsOutreachMessage[]> {
  const { data, error } = await client.schema('admin').rpc('list_analytics_outreach_messages', {
    p_from: query.from,
    p_to: query.to,
    p_search: search || null,
    p_status: status || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  return unwrap((data ?? []) as AnalyticsOutreachMessage[], error);
}

export async function listLlmUsageCharges(
  client: SupabaseClient,
  query: AnalyticsQuery,
  filters: AnalyticsUsageChargeFilters,
  page: number,
  pageSize: number
): Promise<AnalyticsUsageCharge[]> {
  const { data, error } = await client.schema('admin').rpc('list_llm_usage_charges', {
    p_from: query.from,
    p_to: query.to,
    p_search: filters.search || null,
    p_model: filters.model || null,
    p_fallback: filters.fallback,
    p_status: filters.status || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  return unwrap((data ?? []) as AnalyticsUsageCharge[], error);
}

export async function getLlmUsageChargeDetail(
  client: SupabaseClient,
  chargeId: string
): Promise<AnalyticsRow> {
  const { data, error } = await client
    .schema('admin')
    .rpc('get_llm_usage_charge_detail', { p_charge_id: chargeId });
  return unwrap(data as AnalyticsRow | null, error);
}

export async function listCharacterFavoriteLeaderboard(
  client: SupabaseClient,
  query: AnalyticsQuery,
  limit = 50
): Promise<CharacterFavoriteLeaderboardRow[]> {
  const { data, error } = await client.schema('admin').rpc('list_character_favorite_leaderboard', {
    p_from: query.from,
    p_to: query.to,
    p_limit: limit,
  });
  return unwrap((data ?? []) as CharacterFavoriteLeaderboardRow[], error);
}
