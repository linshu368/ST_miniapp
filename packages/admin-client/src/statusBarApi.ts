import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AdminCharacterStatusBarDataSchema,
  AdminSetStatusBarDataSchema,
  AdminStatusBarGenerateDataSchema,
  AdminStatusBarTopDataSchema,
  type AdminCharacterStatusBarData,
  type AdminSetStatusBarData,
  type AdminStatusBarGenerateData,
  type AdminStatusBarTopCard,
  type StatusBarTemplate,
} from '@miniapp/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { readAdminAccessToken } from './textPostprocessApi';

/**
 * 运营给存量卡设定状态栏：收藏量头部卡、读卡上现有的、生成（不落库）、写入。CLI 用。
 * 生成要读长卡资料再调模型（不合格还会重试一次），超时放宽到 200 秒。
 */

const READ_TIMEOUT_MS = 15_000;
const GENERATE_TIMEOUT_MS = 200_000;

export class AdminStatusBarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
  }
}

async function callStatusBarApi<T>(
  client: SupabaseClient,
  url: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; timeoutMs: number },
  schema: ZodType<T, ZodTypeDef, unknown>
): Promise<T> {
  const token = await readAdminAccessToken(client);
  if (!token) throw new AdminStatusBarApiError('登录状态已失效，请重新登录当前环境', 401, null);
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
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    throw new AdminStatusBarApiError(
      timeout ? '等待超时，请稍后重试' : '暂时连不上后端，请稍后重试',
      0,
      timeout ? 'TIMEOUT' : 'NETWORK'
    );
  }
  if (response.status === 401)
    throw new AdminStatusBarApiError('登录状态已失效，请重新登录当前环境', 401, null);
  if (response.status === 403)
    throw new AdminStatusBarApiError('当前账号没有这个环境的权限', 403, null);
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok || !body?.success) {
    throw new AdminStatusBarApiError(
      body?.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      body?.error?.code ?? null
    );
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success)
    throw new AdminStatusBarApiError('后端返回的结构不对，请确认后端已经更新', 0, null);
  return parsed.data;
}

function apiUrl(apiBaseUrl: string, path: string): string {
  const root = apiBaseUrl.replace(/\/+$/, '');
  if (!root) throw new Error('后端地址未配置');
  return `${root}${path}`;
}

const characterPath = (characterId: string) =>
  `/api/admin/characters/${encodeURIComponent(characterId)}/status-bar`;

/** 收藏量从高到低的卡（不含已删除、测试卡）。 */
export async function fetchTopFavoritedCards(
  client: SupabaseClient,
  apiBaseUrl: string,
  limit: number
): Promise<AdminStatusBarTopCard[]> {
  const data = await callStatusBarApi(
    client,
    apiUrl(apiBaseUrl, `/api/admin/status-bar/top-favorited?limit=${limit}`),
    { method: 'GET', timeoutMs: READ_TIMEOUT_MS },
    AdminStatusBarTopDataSchema
  );
  return data.cards;
}

export function fetchCharacterStatusBar(
  client: SupabaseClient,
  apiBaseUrl: string,
  characterId: string
): Promise<AdminCharacterStatusBarData> {
  return callStatusBarApi(
    client,
    apiUrl(apiBaseUrl, characterPath(characterId)),
    { method: 'GET', timeoutMs: READ_TIMEOUT_MS },
    AdminCharacterStatusBarDataSchema
  );
}

/** 只生成、不保存。 */
export function generateCharacterStatusBar(
  client: SupabaseClient,
  apiBaseUrl: string,
  characterId: string,
  model?: string
): Promise<AdminStatusBarGenerateData> {
  return callStatusBarApi(
    client,
    apiUrl(apiBaseUrl, `${characterPath(characterId)}/generate`),
    { method: 'POST', body: model ? { model } : {}, timeoutMs: GENERATE_TIMEOUT_MS },
    AdminStatusBarGenerateDataSchema
  );
}

/** template = null 清空。 */
export function setCharacterStatusBar(
  client: SupabaseClient,
  apiBaseUrl: string,
  characterId: string,
  template: StatusBarTemplate | null
): Promise<AdminSetStatusBarData> {
  return callStatusBarApi(
    client,
    apiUrl(apiBaseUrl, characterPath(characterId)),
    { method: 'PUT', body: { template }, timeoutMs: READ_TIMEOUT_MS },
    AdminSetStatusBarDataSchema
  );
}
