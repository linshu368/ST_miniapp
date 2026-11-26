import dayjs, { type Dayjs } from 'dayjs';
import {
  DEFAULT_FREE_ZONE_CONFIG,
  FreeZoneConfigSchema,
  FreeZoneFallbackSchema,
  type FreeZoneCandidate,
  type FreeZoneConfig,
  formatVipWeeklyWindow,
} from '@miniapp/shared';
import type { ZodIssue } from 'zod';

/**
 * 运营平台「畅聊（免费模型）」表单的纯函数：补默认值、福利期时间换算、校验提示和状态预览。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type SectionKey = 'first_token' | 'usage_limit';

/** 已删除的旧设置：线上存的值里还带着，读进表单时去掉，下次保存就不再写回 */
const REMOVED_KEYS = new Set(['on_shelf', 'relist']);

/** 缺的字段补默认值；运营正在填、还不合法的值原样保留，由校验提示，不偷偷改掉。 */
export function asFreeZoneConfig(value: unknown): FreeZoneConfig {
  const raw = Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(([key]) => !REMOVED_KEYS.has(key))
  );
  const rawScreening = isRecord(raw.screening) ? raw.screening : {};
  const section = <K extends SectionKey>(key: K): FreeZoneConfig[K] =>
    ({
      ...DEFAULT_FREE_ZONE_CONFIG[key],
      ...(isRecord(raw[key]) ? raw[key] : {}),
    }) as FreeZoneConfig[K];
  const defaults = DEFAULT_FREE_ZONE_CONFIG.access;
  const rawAccess = isRecord(raw.access) ? raw.access : {};
  return {
    ...DEFAULT_FREE_ZONE_CONFIG,
    ...raw,
    candidates: Array.isArray(raw.candidates) ? (raw.candidates as FreeZoneCandidate[]) : [],
    screening: {
      min_discount_pct:
        rawScreening.min_discount_pct === undefined
          ? DEFAULT_FREE_ZONE_CONFIG.screening.min_discount_pct
          : rawScreening.min_discount_pct,
      blocked_providers:
        rawScreening.blocked_providers ?? DEFAULT_FREE_ZONE_CONFIG.screening.blocked_providers,
    },
    first_token: section('first_token'),
    usage_limit: section('usage_limit'),
    fallback: isRecord(raw.fallback)
      ? { ...FreeZoneFallbackSchema.parse({}), ...raw.fallback }
      : null,
    access: {
      ...defaults,
      ...rawAccess,
      vip_weekly: {
        ...defaults.vip_weekly,
        ...(isRecord(rawAccess.vip_weekly) ? rawAccess.vip_weekly : {}),
      },
      prompt: { ...defaults.prompt, ...(isRecord(rawAccess.prompt) ? rawAccess.prompt : {}) },
    },
  } as FreeZoneConfig;
}

export const EMPTY_FREE_ZONE_CANDIDATE: FreeZoneCandidate = {
  id: '',
  surplus_model: '',
  display_name: '',
  tagline: '',
  family: '',
  benchmark_tier: 'light',
  parallel_requests: 1,
  min_discount_pct: null,
  turns_per_24h: null,
  route_objective: null,
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

const SECTION_LABELS: Record<string, string> = {
  enabled: '总开关',
  rules_text: '规则文字',
  period: '福利期',
  scope: '使用范围',
  candidates: '候选池',
  screening: '折扣底线与屏蔽渠道',
  first_token: '首字',
  access: '按身份开放',
  usage_limit: '用量上限',
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
  parallel_requests: '并发',
  min_discount_pct: '折扣底线',
  turns_per_24h: '每人每天上限',
  route_objective: '派单',
  blocked_providers: '屏蔽渠道',
  primary_wait_ms: '启动兜底等待',
  deadline_ms: '首字总上限',
  enabled: '开关',
  trial_since: '新人试用起始注册时间',
  trial_hours: '新人试用时长',
  vip_welcome_days: '会员开通礼天数',
  vip_weekly: '会员畅聊日',
  weekday: '周几',
  start_minute: '开始时间',
  duration_minutes: '时长',
  prompt: 'VIP 弹窗频次',
  min_interval_days: '最短间隔',
  batch_size: '每批次数',
  batch_cooldown_days: '每批之后冷却',
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
    return { type: 'info', text: '总开关关闭：用户看不到栏目。' };
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
    return config.access.enabled
      ? {
          type: 'success',
          text: `福利期已经结束，现在按身份开放：${describeFreeZoneAccess(config)}`,
        }
      : { type: 'warning', text: '福利期已经结束：栏目隐藏。要延长就把结束时间往后改。' };
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
  const after = config.access.enabled
    ? `福利期结束后按身份开放：${describeFreeZoneAccess(config)}`
    : '福利期结束后栏目隐藏。';
  return {
    type: 'success',
    text: `开放中：栏目显示「${formatPeriodTime(period.ends_at)} 结束」。${scope}一个在架模型都没有时显示「暂未开放」。${after}`,
  };
}

/** 按身份开放的一句话说明，给状态预览用。 */
export function describeFreeZoneAccess(config: FreeZoneConfig): string {
  const access = config.access;
  const trial = access.trial_since
    ? `${formatPeriodTime(access.trial_since)} 之后注册的新用户注册起 ${access.trial_hours} 小时`
    : '不开新人试用';
  const welcome =
    access.vip_welcome_days > 0 ? `会员开通/续费起 ${access.vip_welcome_days} 天` : '不送开通礼';
  return `${trial}；${welcome}；会员每${formatVipWeeklyWindow(access.vip_weekly)}（北京时间）。其余时间选着免费模型的会直接切到付费默认模型。`;
}
