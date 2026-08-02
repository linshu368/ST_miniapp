import type { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_GRANT_AMOUNT = 500;
export const MIN_GRANT_AMOUNT = 1;
export const MAX_GRANT_AMOUNT = 100_000;

export const AMOUNT_PLACEHOLDER = '{数量}';
export const DEFAULT_GRANT_TITLE = '您的星尘到账了';
export const DEFAULT_GRANT_BODY = `您的回复奖励 ${AMOUNT_PLACEHOLDER} 星尘已到账`;

const TITLE_MAX_LENGTH = 120;
const BODY_MAX_LENGTH = 4000;

export interface GrantUserLookup {
  found: boolean;
  user_id?: string;
  tg_id?: string;
  display_name?: string | null;
  tg_username?: string | null;
  main_credits?: number;
  bonus_credits?: number;
  total_credits?: number;
  created_at?: string;
}

export interface GrantResult {
  /** false 表示这次请求命中了幂等，星尘早已发放过，没有重复加钱。 */
  granted: boolean;
  user_id: string;
  amount: number;
  main_credits: number;
  bonus_credits: number;
  total_credits: number;
  notification_id: string;
  granted_at: string;
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('赠送接口没有返回数据');
  return data;
}

/**
 * 推送文案的唯一渲染入口：预览、二次确认和真正下发都走它，
 * 保证客服看到的就是用户收到的。留空回落默认话术，{数量} 换成实际赠送数量。
 */
export function renderGrantMessage(input: { title: string; body: string; amount: number }): {
  title: string;
  body: string;
} {
  const title = input.title.trim() || DEFAULT_GRANT_TITLE;
  const body = input.body.trim() || DEFAULT_GRANT_BODY;
  const amount = String(input.amount);
  return {
    title: title.split(AMOUNT_PLACEHOLDER).join(amount),
    body: body.split(AMOUNT_PLACEHOLDER).join(amount),
  };
}

/** 返回不可提交的原因，null 表示这份表单可以进二次确认。 */
export function describeGrantIssue(input: {
  userId: string | null;
  amount: number | null;
  title: string;
  body: string;
}): string | null {
  if (!input.userId) return '请先输入用户 ID 并确认用户信息';
  if (input.amount === null || !Number.isInteger(input.amount)) return '赠送数量必须是整数';
  if (input.amount < MIN_GRANT_AMOUNT || input.amount > MAX_GRANT_AMOUNT) {
    return `赠送数量需在 ${MIN_GRANT_AMOUNT} 到 ${MAX_GRANT_AMOUNT} 之间`;
  }
  const rendered = renderGrantMessage({
    title: input.title,
    body: input.body,
    amount: input.amount,
  });
  if (rendered.title.length > TITLE_MAX_LENGTH) return `推送标题不能超过 ${TITLE_MAX_LENGTH} 字`;
  if (rendered.body.length > BODY_MAX_LENGTH) return `推送正文不能超过 ${BODY_MAX_LENGTH} 字`;
  return null;
}

export async function lookupUserForCreditGrant(
  client: SupabaseClient,
  identifier: string
): Promise<GrantUserLookup> {
  const { data, error } = await client.schema('admin').rpc('lookup_user_for_credit_grant', {
    p_identifier: identifier,
  });
  return unwrap(data as GrantUserLookup | null, error);
}

export async function grantUserCredits(input: {
  client: SupabaseClient;
  userId: string;
  amount: number;
  title: string;
  body: string;
  requestId: string;
}): Promise<GrantResult> {
  const { data, error } = await input.client.schema('admin').rpc('grant_user_credits', {
    p_user_id: input.userId,
    p_amount: input.amount,
    p_title: input.title,
    p_body: input.body,
    p_request_id: input.requestId,
  });
  return unwrap(data as GrantResult | null, error);
}
