/**
 * backend / scripts / invite-uat / client.ts
 *
 * 打四条邀请路由的 HTTP 客户端，扮演真实 MiniApp 前端。
 *
 * 鉴权走 MOCK_AUTH=1 的 initData 旁路（middleware/auth.ts 已有的非生产分支），
 * 不需要真实签名。注意 DEV_AUTH_BYPASS 必须在脚本里关掉：不带 header 的请求会被
 * 兜底成 tg_id=99999 的固定用户，"未鉴权 401"那条用例就永远测不到。
 */

import type {
  ApiResponse,
  InviteBindData,
  InviteCenterViewData,
  InviteEntryStatusData,
  InviteStatsData,
} from '@miniapp/shared';

export interface HttpResult<T> {
  status: number;
  body: ApiResponse<T> | null;
  /** 成功响应的 data；失败或非 2xx 时为 null。 */
  data: T | null;
}

/**
 * 本机跑脚本时后端到 Supabase 走公网，偶发 `TypeError: fetch failed` 会让 handler 返回
 * 500 并把断言染成假红。四条邀请路由按契约全部幂等（绑定的五种状态均为终态、
 * center-view 是幂等 POST），所以对 500 做有界重试是安全的。
 *
 * 只重试 500：401 / 4xx 是判据本身，持续 500 也会在重试耗尽后照实上报。
 * 重试次数计入 transientRetryCount，由 run.ts 打出来，避免把真实抖动藏起来。
 */
const MAX_TRANSIENT_RETRIES = 3;
let transientRetryCount = 0;

export function getTransientRetryCount(): number {
  return transientRetryCount;
}

/** MOCK_AUTH=1 时 verifyTelegramInitData 只解析 user 参数，不验签。 */
export function buildInitData(tgId: string, displayName = '裂变 UAT 用户'): string {
  const user = { id: Number(tgId), first_name: displayName, username: `invite_uat_${tgId}` };
  return `auth_date=${Math.floor(Date.now() / 1000)}&user=${encodeURIComponent(JSON.stringify(user))}`;
}

interface CallOptions {
  baseUrl: string;
  method: 'GET' | 'POST';
  path: string;
  /** 省略则完全不发 X-Init-Data header，用于未鉴权用例。 */
  initData?: string;
  body?: unknown;
}

async function callOnce<T>(options: CallOptions): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {};
  if (options.initData !== undefined) headers['X-Init-Data'] = options.initData;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(new URL(options.path, options.baseUrl), {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: ApiResponse<T> | null = null;
  try {
    body = JSON.parse(text) as ApiResponse<T>;
  } catch {
    body = null;
  }
  const data = body !== null && body.success === true ? body.data : null;
  return { status: response.status, body, data };
}

async function call<T>(options: CallOptions): Promise<HttpResult<T>> {
  let result = await callOnce<T>(options);
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES && result.status === 500; attempt += 1) {
    transientRetryCount += 1;
    await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    result = await callOnce<T>(options);
  }
  return result;
}

export function getEntryStatus(
  baseUrl: string,
  initData?: string
): Promise<HttpResult<InviteEntryStatusData>> {
  return call<InviteEntryStatusData>({
    baseUrl,
    method: 'GET',
    path: '/api/invite/entry-status',
    initData,
  });
}

export function postCenterView(
  baseUrl: string,
  initData?: string
): Promise<HttpResult<InviteCenterViewData>> {
  return call<InviteCenterViewData>({
    baseUrl,
    method: 'POST',
    path: '/api/invite/center-view',
    initData,
  });
}

export function postBind(
  baseUrl: string,
  initData: string | undefined,
  inviteCode: unknown
): Promise<HttpResult<InviteBindData>> {
  return call<InviteBindData>({
    baseUrl,
    method: 'POST',
    path: '/api/invite/bind',
    initData,
    body: { invite_code: inviteCode },
  });
}

export function getStats(baseUrl: string, initData?: string): Promise<HttpResult<InviteStatsData>> {
  return call<InviteStatsData>({ baseUrl, method: 'GET', path: '/api/invite/stats', initData });
}
