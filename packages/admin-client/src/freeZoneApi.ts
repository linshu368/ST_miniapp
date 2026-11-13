import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AdminFreeZoneDelistNowResponseSchema,
  AdminFreeZoneListNowResponseSchema,
  AdminFreeZoneScreeningResponseSchema,
  AdminFreeZoneStatusResponseSchema,
  type AdminFreeZoneDelistNowRequest,
  type AdminFreeZoneDelistNowResponse,
  type AdminFreeZoneListNowRequest,
  type AdminFreeZoneListNowResponse,
  type AdminFreeZoneScreeningRequest,
  type AdminFreeZoneScreeningResponse,
  type AdminFreeZoneStatusModel,
  type AdminFreeZoneStatusResponse,
  type FreeZoneScreeningCheckKey,
} from '@miniapp/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { readAdminAccessToken } from './textPostprocessApi';

/**
 * 畅聊调试接口：线上状态、按门槛筛选候选池（只读），以及手动立即上架、手动下架。网页和 CLI 共用。
 * 筛选要实时问 Surplus，候选多时要等十几秒，超时放宽到 60 秒。
 */

const SCREENING_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
/** 要现问行情，再真发派单探测（最多探 3 家，每家最多 20 秒） */
const LIST_NOW_TIMEOUT_MS = 90_000;

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

/** 立即上架一个候选（跳过连续达标和冷却）；不指定供应商时按当前行情选。 */
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

/** 手动下架一个在架模型；下架后一直停着，要用时走立即上架。 */
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
  probe: '探测派单',
};

export const FREE_ZONE_STATUS_LABELS = {
  listed: '在架',
  unlisted: '未上架',
  cooling: '冷却中',
} as const;

export interface FreeZoneReasonTag {
  text: string;
  /** true：没有一家 trusted 供应商过了这一项（就是它把模型卡住） */
  failed: boolean;
  /** 悬停说明：几家里有几家过了 */
  hint: string;
}

export type FreeZoneReasonView =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'tags'; tags: FreeZoneReasonTag[]; note: string | null };

/**
 * 「最近原因」怎么展示：在架或初筛已通过的不说（除非有别的原因，比如达标供应商都在排除期）；
 * 没通过的，每个检查项一个标签——没有一家过的标红排前面，有人过的标灰。
 * 每项都有人过、却没有一家全过时，补一句最接近的那家差哪几项。
 */
export function freeZoneReasonView(model: AdminFreeZoneStatusModel): FreeZoneReasonView {
  if (model.status === 'listed') return { kind: 'none' };
  const summary = model.screening;
  if (!summary || summary.pass) {
    return model.last_reason ? { kind: 'text', text: model.last_reason } : { kind: 'none' };
  }
  const checks = summary.checks.filter((item) => item.threshold !== null);
  if (checks.every((item) => item.total === 0)) {
    const blocked = model.last_reason?.split('；').find((part) => part.startsWith('只有屏蔽渠道'));
    return {
      kind: 'tags',
      tags: [
        blocked
          ? { text: blocked, failed: true, hint: '这个模型的 trusted 供应商都在屏蔽渠道里' }
          : { text: '没有 trusted 供应商', failed: true, hint: '这个模型没有 trusted 供应商挂单' },
      ],
      note: null,
    };
  }
  const tags = checks
    .map((item) => {
      const label = FREE_ZONE_CHECK_LABELS[item.key];
      const modelLevel = item.key === 'min_realized_discount_pct';
      return {
        text: modelLevel ? label : `${label} ${item.passed}/${item.total}`,
        failed: item.passed === 0,
        hint: modelLevel
          ? `模型整体${item.passed === 0 ? '没过' : '过了'}`
          : item.key === 'probe'
            ? `真发请求探了 ${item.total} 家，${item.passed} 家带 ${item.threshold}% 折扣底线派得出去`
            : `${item.total} 家 trusted 供应商里有 ${item.passed} 家过了`,
      };
    })
    .sort((a, b) => Number(b.failed) - Number(a.failed));
  const closest = summary.closest;
  const note =
    tags.some((tag) => tag.failed) || !closest
      ? null
      : `每项都有供应商过，但没有一家全过；最接近的 ${closest.provider} 差：${closest.failed
          .map((key) => FREE_ZONE_CHECK_LABELS[key])
          .join('、')}`;
  return { kind: 'tags', tags, note };
}

export type FreeZoneStatusGroup = 'listed' | 'not_listed' | 'business_delisted';

/** 线上状态分三块（网页与 CLI 共用的顺序和说明）。 */
export const FREE_ZONE_STATUS_GROUPS: ReadonlyArray<{
  key: FreeZoneStatusGroup;
  label: string;
  hint: string;
}> = [
  { key: 'listed', label: '在架', hint: '用户现在能选的' },
  {
    key: 'not_listed',
    label: '未上架',
    hint: '从没上过架的，以及上过架、因 Surplus 官方数据不达标下架的（标「曾上架」）',
  },
  {
    key: 'business_delisted',
    label: '因业务数据下架',
    hint: '上过架，在我们自己的流量上越线被下掉的；冷却期满、重新达标后会回到在架',
  },
];

/** 在架看当前状态；不在架的，最近一次是因业务数据下架的单独一块，其余都算未上架。 */
/**
 * 运营手动下架、还没重新上架：冷却中且最近一次下架没有原因分类（自动下架都带 official/business）。
 * 这种不会自动回来，状态显示「手动下架」而不是冷却到某个时间。
 */
export function isFreeZoneManualHold(model: AdminFreeZoneStatusModel): boolean {
  return (
    model.status === 'cooling' && model.last_delist !== null && model.last_delist.cause === null
  );
}

/** 状态标签：手动下架单独显示，其余按状态。 */
export function freeZoneStatusLabel(model: AdminFreeZoneStatusModel): string {
  if (!model.status) return '未评估';
  return isFreeZoneManualHold(model) ? '手动下架' : FREE_ZONE_STATUS_LABELS[model.status];
}

export function freeZoneStatusGroup(model: AdminFreeZoneStatusModel): FreeZoneStatusGroup {
  if (model.status === 'listed') return 'listed';
  if (model.last_delist?.cause === 'business') return 'business_delisted';
  return 'not_listed';
}

/** 在架模型的探测首字，给「详情」用：「探测首字 2.3 秒」；没有探测为空串。 */
export function freeZoneProbeText(model: AdminFreeZoneStatusModel): string {
  const probe = model.probe;
  if (!probe || probe.outcome !== 'ok' || probe.first_token_ms === null) return '';
  return `探测首字 ${(probe.first_token_ms / 1000).toFixed(1)} 秒`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 10) / 10}%`;
}

/**
 * 在架模型的业务数据一句话：兜底多了是花钱，中断是用户体验实打实受损，两个都摆出来。
 * 只统计当前供应商开始用之后、统计窗口内的轮次，截至最近一轮评估。
 */
export function freeZoneBusinessText(model: AdminFreeZoneStatusModel): string {
  const business = model.business;
  if (!business) return '';
  if (business.turns === 0) return '还没有用户轮次';
  const interrupted =
    business.interrupted_turns !== null && business.primary_delivered_turns
      ? `中断 ${pct(business.interrupted_pct)}（${business.interrupted_turns}/${business.primary_delivered_turns}）`
      : `中断 ${pct(business.interrupted_pct)}`;
  return [
    `${business.turns} 轮`,
    `兜底 ${pct(business.fallback_delivered_pct)}`,
    interrupted,
    `没出字 ${pct(business.no_output_pct)}`,
  ].join(' · ');
}
