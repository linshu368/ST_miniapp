import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AdminFreeZoneScreeningResponseSchema,
  AdminFreeZoneStatusResponseSchema,
  type AdminFreeZoneScreeningRequest,
  type AdminFreeZoneScreeningResponse,
  type AdminFreeZoneStatusResponse,
  type FreeZoneScreeningCheckKey,
} from '@miniapp/shared';
import type { ZodType } from 'zod';
import { readAdminAccessToken } from './textPostprocessApi';

/**
 * 畅聊调试接口（只读）：线上状态、按门槛筛选候选池。网页和 CLI 共用。
 * 筛选要实时问 Surplus，候选多时要等十几秒，超时放宽到 60 秒。
 */

const SCREENING_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;

async function callFreeZoneApi<T>(
  client: SupabaseClient,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
  schema: ZodType<T>
): Promise<T> {
  const token = await readAdminAccessToken(client);
  if (!token) throw new Error('登录状态已失效，请重新登录当前环境');
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.name === 'TimeoutError'
        ? '等待超时，请稍后重试'
        : '暂时连不上后端，请稍后重试'
    );
  }
  if (response.status === 401) throw new Error('登录状态已失效，请重新登录当前环境');
  if (response.status === 403) throw new Error('当前账号没有这个环境的权限');
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
    error?: { message?: string };
    message?: string;
  } | null;
  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? body?.message ?? `请求失败（${response.status}）`);
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) throw new Error('后端返回的结构不对，请确认后端已经更新');
  return parsed.data;
}

function apiUrl(apiBaseUrl: string, path: string): string {
  const root = apiBaseUrl.replace(/\/+$/, '');
  if (!root) throw new Error('后端地址未配置');
  return `${root}${path}`;
}

export function fetchFreeZoneStatus(
  client: SupabaseClient,
  apiBaseUrl: string
): Promise<AdminFreeZoneStatusResponse> {
  return callFreeZoneApi(
    client,
    apiUrl(apiBaseUrl, '/api/admin/free-zone/status'),
    { method: 'GET', timeoutMs: STATUS_TIMEOUT_MS },
    AdminFreeZoneStatusResponseSchema
  );
}

/** 不传 input 时，后端用已发布配置的候选和门槛。 */
export function screenFreeZoneCandidates(
  client: SupabaseClient,
  apiBaseUrl: string,
  input?: AdminFreeZoneScreeningRequest
): Promise<AdminFreeZoneScreeningResponse> {
  return callFreeZoneApi(
    client,
    apiUrl(apiBaseUrl, '/api/admin/free-zone/screening'),
    { method: 'POST', body: input, timeoutMs: SCREENING_TIMEOUT_MS },
    AdminFreeZoneScreeningResponseSchema
  );
}

/** 初筛各项的中文名（网页表头与 CLI 输出共用）。 */
export const FREE_ZONE_CHECK_LABELS: Record<FreeZoneScreeningCheckKey, string> = {
  min_qualified_offers: '达标报价数',
  min_samples: '样本量',
  min_uptime_pct: '成功率',
  max_ttft_p50_ms: '首字 p50',
  max_ttft_p90_ms: '首字 p90',
  min_tps: '出字速度',
  min_cache_hit_rate_pct: '缓存命中率',
  min_realized_discount_pct: '7 天成交折扣',
};

export const FREE_ZONE_STATUS_LABELS = {
  listed: '在架',
  unlisted: '未上架',
  cooling: '冷却中',
} as const;
