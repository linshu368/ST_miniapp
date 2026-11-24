import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AdminFreeZoneDelistNowResponseSchema,
  AdminFreeZoneListNowResponseSchema,
  AdminFreeZoneStatusResponseSchema,
  type AdminFreeZoneDelistNowRequest,
  type AdminFreeZoneDelistNowResponse,
  type AdminFreeZoneListNowRequest,
  type AdminFreeZoneListNowResponse,
  type AdminFreeZoneStatusModel,
  type AdminFreeZoneStatusResponse,
} from '@miniapp/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { readAdminAccessToken } from './textPostprocessApi';

/**
 * 畅聊接口：线上状态（只读），以及手动上架、手动下架。网页和 CLI 共用。
 */

const STATUS_TIMEOUT_MS = 15_000;
/** 没指定供应商时要现问一次 Surplus 报价（后端 8 秒上限） */
const LIST_NOW_TIMEOUT_MS = 20_000;

async function callFreeZoneApi<T>(
  client: SupabaseClient,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
  schema: ZodType<T, ZodTypeDef, unknown>
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

/** 上架一个候选；不指定供应商时选达到折扣底线、折扣最高的一家。 */
export function listFreeZoneModelNow(
  client: SupabaseClient,
  apiBaseUrl: string,
  request: AdminFreeZoneListNowRequest
): Promise<AdminFreeZoneListNowResponse> {
  return callFreeZoneApi(
    client,
    apiUrl(apiBaseUrl, '/api/admin/free-zone/list-now'),
    { method: 'POST', body: request, timeoutMs: LIST_NOW_TIMEOUT_MS },
    AdminFreeZoneListNowResponseSchema
  );
}

/** 手动下架一个在架模型；不会自动回来，要用时再上架。 */
export function delistFreeZoneModelNow(
  client: SupabaseClient,
  apiBaseUrl: string,
  request: AdminFreeZoneDelistNowRequest
): Promise<AdminFreeZoneDelistNowResponse> {
  return callFreeZoneApi(
    client,
    apiUrl(apiBaseUrl, '/api/admin/free-zone/delist-now'),
    { method: 'POST', body: request, timeoutMs: STATUS_TIMEOUT_MS },
    AdminFreeZoneDelistNowResponseSchema
  );
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

export const FREE_ZONE_STATUS_LABELS = { listed: '在架', unlisted: '未上架' } as const;

export type FreeZoneStatusGroup = AdminFreeZoneStatusModel['status'];

/** 线上状态分两块（网页与 CLI 共用的顺序和说明）。 */
export const FREE_ZONE_STATUS_GROUPS: ReadonlyArray<{
  key: FreeZoneStatusGroup;
  label: string;
  hint: string;
}> = [
  { key: 'listed', label: '在架', hint: '用户现在能选的；连续被拒单会自动下架，其余只由运营下架' },
  { key: 'unlisted', label: '未上架', hint: '要用时点「上架」，不会自动上来' },
];

/** 上次下架是怎么回事，给「详情」用；从没下架过为空串。 */
export function freeZoneDelistText(model: AdminFreeZoneStatusModel): string {
  return model.last_delist?.reason ?? '';
}
