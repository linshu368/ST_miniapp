import dayjs, { type Dayjs } from 'dayjs';
import {
  AdminFreeZoneScreeningRequestSchema,
  DEFAULT_FREE_ZONE_CONFIG,
  FreeZoneConfigSchema,
  type AdminFreeZoneScreeningRequest,
  type FreeZoneCandidate,
  type FreeZoneConfig,
  type FreeZoneScreeningCheckKey,
} from '@miniapp/shared';
import type { ZodIssue } from 'zod';

/**
 * 运营平台「畅聊（免费模型）」表单的纯函数：补默认值、福利期时间换算、校验提示和状态预览。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type SectionKey = 'screening' | 'on_shelf' | 'relist' | 'first_token';

/** 缺的字段补默认值；运营正在填、还不合法的值原样保留，由校验提示，不偷偷改掉。 */
export function asFreeZoneConfig(value: unknown): FreeZoneConfig {
  const raw = isRecord(value) ? value : {};
  const section = <K extends SectionKey>(key: K): FreeZoneConfig[K] =>
    ({
      ...DEFAULT_FREE_ZONE_CONFIG[key],
      ...(isRecord(raw[key]) ? raw[key] : {}),
    }) as FreeZoneConfig[K];
  return {
    ...DEFAULT_FREE_ZONE_CONFIG,
    ...raw,
    candidates: Array.isArray(raw.candidates) ? (raw.candidates as FreeZoneCandidate[]) : [],
    screening: section('screening'),
    on_shelf: section('on_shelf'),
    relist: section('relist'),
    first_token: section('first_token'),
  } as FreeZoneConfig;
}

export const EMPTY_FREE_ZONE_CANDIDATE: FreeZoneCandidate = {
  id: '',
  surplus_model: '',
  display_name: '',
  tagline: '',
  family: '',
  benchmark_tier: 'light',
  thinking: 'switchable',
};

/** 新候选的 id 留空时，按 Surplus 模型名生成一个：deepseek-v4.1 → free-deepseek-v4-1。 */
export function deriveCandidateId(surplusModel: string): string {
  const slug = surplusModel
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `free-${slug}` : '';
}

/** 福利期存带时区的 ISO 时间（运营在国内填，就是 +08:00），精确到分钟。 */
export function toPeriodTime(value: Dayjs): string {
  return value.second(0).millisecond(0).format('YYYY-MM-DDTHH:mm:ssZ');
}

export function formatPeriodTime(iso: string): string {
  return dayjs(iso).format('M月D日 HH:mm');
}

/** 业务原因冷却梯度：逗号或空格分隔的分钟数。 */
export function parseMinutesList(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .filter((item) => item.length > 0)
    .map((item) => Number(item));
}

const SECTION_LABELS: Record<string, string> = {
  enabled: '总开关',
  rules_text: '规则文字',
  period: '福利期',
  scope: '使用范围',
  candidates: '候选池',
  screening: '官方数据初筛',
  on_shelf: '在架业务数据',
  relist: '上架与冷却',
  first_token: '首字',
};

const FIELD_LABELS: Record<string, string> = {
  starts_at: '开始时间',
  ends_at: '结束时间',
  id: '免费模型 id',
  surplus_model: 'Surplus 模型名',
  display_name: '显示名',
  tagline: '介绍语',
  family: '系列',
  benchmark_tier: '对标档位',
  thinking: '深度思考',
  min_discount_pct: '折扣底线',
  min_qualified_offers: '达标报价数',
  min_realized_discount_pct: '7 天成交折扣',
  min_uptime_pct: '成功率',
  max_ttft_p50_ms: '首字 p50 上限',
  max_ttft_p90_ms: '首字 p90 上限',
  min_tps: '出字速度',
  min_cache_hit_rate_pct: '缓存命中率',
  min_samples: '最少样本',
  price_band_ratio: '价格分档倍数',
  probe_enabled: '派单探测',
  max_probe_ttft_ms: '探测首字上限',
  window_hours: '统计窗口',
  min_turns: '最少轮数',
  max_no_output_pct: '没出字率',
  max_fallback_delivered_pct: '兜底交付率',
  max_timeout_pct: '超时率',
  max_refusal_pct: '拒答率',
  max_truncation_pct: '截断率',
  max_interrupted_pct: '生成中断率',
  max_dislike_pct: '点踩率',
  required_passes: '连续达标次数',
  cooldown_official_minutes: '官方原因冷却',
  cooldown_business_minutes: '业务原因冷却梯度',
  primary_wait_ms: '启动兜底等待',
  deadline_ms: '首字总上限',
};

function issuePlace(path: ReadonlyArray<string | number>): string {
  const parts: string[] = [];
  for (const [index, segment] of path.entries()) {
    if (typeof segment === 'number') {
      parts.push(
        path[index - 1] === 'candidates' ? `第 ${segment + 1} 行` : `第 ${segment + 1} 项`
      );
    } else {
      parts.push((index === 0 ? SECTION_LABELS[segment] : FIELD_LABELS[segment]) ?? segment);
    }
  }
  return parts.join(' · ');
}

function issueText(issue: ZodIssue): string {
  if (issue.code === 'invalid_type') {
    return issue.received === 'null' || issue.received === 'undefined' ? '不能留空' : '格式不对';
  }
  if (issue.code === 'too_small') {
    return issue.type === 'string' ? '不能为空' : `不能小于 ${String(issue.minimum)}`;
  }
  if (issue.code === 'too_big') {
    return issue.type === 'string'
      ? `最多 ${String(issue.maximum)} 字`
      : issue.type === 'array'
        ? `最多 ${String(issue.maximum)} 个`
        : `不能大于 ${String(issue.maximum)}`;
  }
  if (issue.code === 'invalid_string' && issue.message === 'Invalid') {
    return '只能用字母、数字、点、横线、下划线';
  }
  if (issue.code === 'invalid_enum_value') return '选项不对';
  return issue.message;
}

/** 校验不通过的项，转成运营看得懂的一句话：「候选池 · 第 3 行 · 显示名：不能为空」。 */
export function freeZoneIssues(value: FreeZoneConfig): string[] {
  const parsed = FreeZoneConfigSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const place = issuePlace(issue.path);
    return place ? `${place}：${issueText(issue)}` : issueText(issue);
  });
}

export interface FreeZoneStatusPreview {
  type: 'info' | 'success' | 'warning';
  text: string;
}

/** 按当前填的值，预览用户这会儿会看到什么。 */
export function describeFreeZoneStatus(config: FreeZoneConfig, now: Date): FreeZoneStatusPreview {
  if (!config.enabled) {
    return { type: 'info', text: '总开关关闭：用户看不到栏目。候选评估照常进行。' };
  }
  const period = config.period;
  if (!period) {
    return { type: 'warning', text: '还没填福利期：开了总开关栏目也不会显示。' };
  }
  const startsAt = Date.parse(period.starts_at);
  const endsAt = Date.parse(period.ends_at);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) {
    return { type: 'warning', text: '福利期时间不合法。' };
  }
  if (now.getTime() >= endsAt) {
    return { type: 'warning', text: '福利期已经结束：栏目隐藏。要延长就把结束时间往后改。' };
  }
  const scope =
    config.scope === 'own_cards'
      ? '只有用户自己创作的角色卡能用，别人的卡上显示「仅限自创角色卡」。'
      : '所有角色卡都能用。';
  if (now.getTime() < startsAt) {
    return {
      type: 'info',
      text: `福利期还没开始：栏目折叠显示「${formatPeriodTime(period.starts_at)} 开始」，可以预览、不能选。开始后${scope}`,
    };
  }
  return {
    type: 'success',
    text: `开放中：栏目显示「${formatPeriodTime(period.ends_at)} 结束」。${scope}一个在架模型都没有时显示「暂未开放」。`,
  };
}

/**
 * 「按当前门槛筛选」的请求：用页面上还没保存的候选和门槛；模型名还没填好的行先跳过。
 * 门槛本身不合法时返回 null（按钮置灰，先把门槛改对）。
 */
export function screeningRequestFrom(config: FreeZoneConfig): AdminFreeZoneScreeningRequest | null {
  const parsed = AdminFreeZoneScreeningRequestSchema.safeParse({
    candidates: config.candidates
      .map((candidate) => ({
        id: candidate.id.trim(),
        surplus_model: candidate.surplus_model.trim(),
        display_name: candidate.display_name.trim(),
      }))
      .filter((candidate) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(candidate.surplus_model)),
    screening: config.screening,
  });
  return parsed.success ? parsed.data : null;
}

export function formatCheckValue(key: FreeZoneScreeningCheckKey, value: number | null): string {
  if (value === null) return '未知';
  const oneDecimal = Math.round(value * 10) / 10;
  if (
    key === 'min_uptime_pct' ||
    key === 'min_cache_hit_rate_pct' ||
    key === 'min_realized_discount_pct'
  ) {
    return `${oneDecimal}%`;
  }
  if (key === 'max_ttft_p50_ms' || key === 'max_ttft_p90_ms') return `${Math.round(value)}ms`;
  if (key === 'min_tps') return String(oneDecimal);
  return String(Math.round(value));
}

/** Surplus 价格是每百万 token 的微美元。 */
export function formatPricePer1m(micro: number | null): string {
  return micro === null ? '—' : `$${(micro / 1_000_000).toFixed(2)}`;
}
