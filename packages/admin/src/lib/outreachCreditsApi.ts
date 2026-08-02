import type { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_GRANT_AMOUNT = 500;
export const MIN_GRANT_AMOUNT = 1;
export const MAX_GRANT_AMOUNT = 100_000;

export const AMOUNT_PLACEHOLDER = '{数量}';
export const DEFAULT_GRANT_TITLE = '您的星尘到账了';
export const DEFAULT_GRANT_BODY = `您的回复奖励 ${AMOUNT_PLACEHOLDER} 星尘已到账`;

const TITLE_MAX_LENGTH = 120;
const BODY_MAX_LENGTH = 4000;

export interface RecentGrant {
  amount: number;
  created_at: string;
}

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
  recent_grants?: RecentGrant[];
}

export interface GrantResult {
  /** false 表示没有加钱：要么命中幂等（早已发放过），要么被重复窗拦下等客服确认。 */
  granted: boolean;
  /** true 表示同一人同一金额十分钟内已发过，需要客服显式放行才继续。 */
  blocked: boolean;
  reason?: 'duplicate_window';
  user_id: string;
  amount: number;
  main_credits?: number;
  bonus_credits?: number;
  total_credits?: number;
  notification_id?: string;
  granted_at?: string;
  last_amount?: number;
  last_granted_at?: string;
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

const REQUEST_ID_PREFIX = 'mijing-admin-grant-request';

/**
 * 幂等键只按「环境 + 收款人 + 金额」派生，不含推送文案：
 * 发放超时后客服改一版措辞再重试，钱的身份没变，就不该换一个新的幂等键。
 */
export function grantRequestKey(input: {
  environment: string;
  userId: string;
  amount: number;
}): string {
  return `${REQUEST_ID_PREFIX}|${input.environment}|${input.userId}|${input.amount}`;
}

/**
 * 同一个 key 始终拿到同一个 request id，跨取消、跨刷新、跨关标签都不变，
 * 只有确认发放成功后才由 clearGrantRequestId 作废。这样「超时后重来」一定会
 * 命中服务端幂等，而不是变成第二次真实扣款。
 */
export function ensureGrantRequestId(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string,
  createId: () => string
): string {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const id = createId();
  storage.setItem(key, id);
  return id;
}

export function clearGrantRequestId(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string
): void {
  storage.removeItem(key);
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
  allowDuplicate?: boolean;
}): Promise<GrantResult> {
  const { data, error } = await input.client.schema('admin').rpc('grant_user_credits', {
    p_user_id: input.userId,
    p_amount: input.amount,
    p_title: input.title,
    p_body: input.body,
    p_request_id: input.requestId,
    p_allow_duplicate: input.allowDuplicate ?? false,
  });
  return unwrap(data as GrantResult | null, error);
}
