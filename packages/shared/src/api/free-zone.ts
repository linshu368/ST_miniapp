import { z } from 'zod';
import { ModelCatalogTierKeySchema } from './model-tier-key.js';

/**
 * 畅聊栏目（免费模型）：运营配置与公开契约。
 *
 * 候选池里的模型来自 Surplus 低价池，上架、下架由运营手动操作；只有真实请求连续被 Surplus 拒单
 * （报价跌破折扣底线、没有卖家）会自动下架，恢复也由运营手动点。出错一律由兜底接住，不因错误率下架。
 */
export const FREE_ZONE_CONFIG_KEY = 'free_zone_config';

/** 免费模型 id 统一带这个前缀，和付费目录的 id 在任何地方都不会撞。 */
export const FREE_ZONE_MODEL_ID_PREFIX = 'free-';

export function isFreeZoneModelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(FREE_ZONE_MODEL_ID_PREFIX);
}

const PercentSchema = z.number().min(0).max(100);
const DurationMsSchema = z.number().int().positive().max(110_000);
const IsoTimeSchema = z.string().datetime({ offset: true });

/**
 * 每人每天最多用几轮（北京时间每天 12 点清零，只数成功的轮次，含重新生成）。字段名沿用 turns_per_24h。
 * 留空：模型上留空用全局上限，
 * 全局也留空就不限。候选池和模型目录「免费畅聊」板块共用。
 */
export const FreeZoneTurnLimitSchema = z.number().int().min(1).max(5000).nullable();

/** 免费模型 id：候选池和模型目录「免费畅聊」板块共用 */
export const FreeZoneModelIdSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^free-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, '免费模型 id 必须以 free- 开头');

/** Surplus 路由目标：latency 同价格带内按实测 p50 最快排，reliability 按近期成功率排 */
export const SurplusRouteObjectiveSchema = z.enum(['latency', 'reliability']);

export const FreeZoneCandidateSchema = z.object({
  id: FreeZoneModelIdSchema,
  /** Surplus 的标准模型名，例如 deepseek-v4-pro */
  surplus_model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  display_name: z.string().trim().min(1).max(40),
  /** 一句话介绍，可以留空（留空时栏目里不显示这一行） */
  tagline: z.string().trim().max(40).default(''),
  /** 系列：下架时优先换同系列，例如 deepseek、gemini */
  family: z.string().trim().min(1).max(40),
  /** 对标档位：划线原价取这一档当前的星尘价 */
  benchmark_tier: ModelCatalogTierKeySchema,
  /**
   * 在架时每轮同时发几路主请求（1–3）：先出字的胜出、其余取消；都没在「启动兜底等待」内出字，
   * 就和兜底一起竞争。用来压兜底率高的模型，代价是多花几路的 Surplus 费用。
   */
  parallel_requests: z.number().int().min(1).max(3).default(1),
  /**
   * 这个模型单独的折扣底线（%）；留空用统一底线。上架选供应商和真实请求的 X-Min-Discount
   * 都按它。有些模型原价本来就低，可以放宽一点。
   */
  min_discount_pct: z.number().int().min(1).max(100).nullable().default(null),
  /** 这个模型每人每天最多几轮；留空用全局上限（usage_limit.turns_per_24h） */
  turns_per_24h: FreeZoneTurnLimitSchema.default(null),
  /**
   * 首发怎么挑卖家：留空 = 统一的可靠优先（最便宜一档里按成功率）；latency = 首字优先，
   * 折扣底线以上的卖家都按实测首字 p50 排（价格带放到最宽，价格上限就是折扣底线）。
   */
  route_objective: SurplusRouteObjectiveSchema.nullable().default(null),
});

/**
 * 折扣底线与屏蔽渠道。键名沿用旧的 screening：线上已存的值直接可读，已删掉的初筛门槛由 zod 丢弃。
 */
export const FreeZoneScreeningSchema = z.object({
  /** 统一折扣底线，作为请求时的 X-Min-Discount；候选单独设了就按候选的 */
  min_discount_pct: z.number().int().min(1).max(100).default(85),
  /**
   * 屏蔽的渠道（Surplus 供应商名，不分大小写）：上架时不选、也不能手动指定。
   * 例如 dashscope-cn 会因内容审核把角色扮演回复写到一半掐断。
   */
  blocked_providers: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
});

/**
 * 用量上限：防个别用户一直猛聊把成本拖垮。某个免费模型用满后，发消息时自动换到同系列、
 * 再到其他没用满的免费模型，都用满了换付费默认模型，并在那一轮回复下轻提示一句。
 */
export const FreeZoneUsageLimitSchema = z.object({
  /** 全局：模型自己没设上限时，每人每天最多几轮；留空不限 */
  turns_per_24h: FreeZoneTurnLimitSchema.default(null),
});

/**
 * 永远不派给的 Surplus 供应商（所有 Surplus 请求都带 providers_blocked，与屏蔽渠道配置取并集）。
 * dashscope-cn（阿里云）内容审核会把角色扮演回复写到一半掐断（data_inspection_failed）。
 */
export const SURPLUS_ALWAYS_BLOCKED_PROVIDERS: readonly string[] = ['dashscope-cn'];

/**
 * 畅聊专用兜底（只用于畅聊轮次的首字兜底和出字后擦掉重写；付费档位的兜底在模型目录）。
 * 和畅聊候选不同：不设折扣底线，原价也照样兜底；不计连续拒单、没有上下架状态。
 */
export const FreeZoneFallbackSchema = z.object({
  /** Surplus 的标准模型名 */
  surplus_model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    .default('deepseek-v4.1-flash-1017'),
  /** 优先的供应商（Surplus provider_order：只排序、不限定）；没卖家时 Surplus 在其余 trusted 里挑。null 不排序 */
  preferred_provider: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, '供应商名只能是小写字母、数字和 . _ -')
    .nullable()
    .default('mistral'),
  route_objective: SurplusRouteObjectiveSchema.default('latency'),
  /** 价格带：比最便宜的报价贵多少百分比以内都按路由目标排（服务端会截断）；超出的排在后面、失败时仍可轮到 */
  price_tolerance_pct: z.number().int().min(0).max(10_000).default(1000),
});

export const FreeZoneFirstTokenSchema = z
  .object({
    /** 主模型等多久还没出字就启动兜底 */
    primary_wait_ms: DurationMsSchema.default(4000),
    /** 首字总上限 */
    deadline_ms: DurationMsSchema.default(7500),
  })
  .refine((value) => value.primary_wait_ms < value.deadline_ms, {
    message: '启动兜底的等待时间必须短于首字总上限',
    path: ['primary_wait_ms'],
  });

export const FreeZonePeriodSchema = z
  .object({ starts_at: IsoTimeSchema, ends_at: IsoTimeSchema })
  .refine((value) => Date.parse(value.starts_at) < Date.parse(value.ends_at), {
    message: '福利期结束时间必须晚于开始时间',
    path: ['ends_at'],
  });

export const FreeZoneScopeSchema = z.enum(['all_cards', 'own_cards']);

/** 会员每周畅聊日（北京时间）。默认周四 12:00 起 15 小时，到周五 03:00。 */
export const FreeZoneVipWeeklySchema = z.object({
  /** ISO 周几：1 = 周一 … 7 = 周日 */
  weekday: z.number().int().min(1).max(7).default(4),
  /** 当天从第几分钟开始（720 = 12:00） */
  start_minute: z.number().int().min(0).max(1439).default(720),
  /** 持续多少分钟，可以跨到第二天（900 = 到次日 03:00）；最长一周 */
  duration_minutes: z.number().int().min(30).max(10_080).default(900),
});

/**
 * VIP 弹窗频次：两次至少隔 min_interval_days 天；每弹满 batch_size 次，
 * 距上一次要满 batch_cooldown_days 天才再弹——这样任意 batch_cooldown_days 天内不超过 batch_size 次。
 */
export const FreeZoneAccessPromptSchema = z.object({
  min_interval_days: z.number().int().min(0).max(90).default(3),
  batch_size: z.number().int().min(1).max(10).default(3),
  batch_cooldown_days: z.number().int().min(0).max(365).default(30),
});

/**
 * 福利期之外按身份开放（北京时间）。总开关关着时只有福利期，和最初版本一样。
 * - 新人试用：trial_since 之后注册的用户，注册起 trial_hours 小时；
 * - 会员开通礼：最近一次开通/续费起 vip_welcome_days 天；
 * - 会员每周畅聊日：vip_weekly。
 * 都只在会员有效期内算；对用户关闭时选着免费模型的照常生成，换成付费默认模型。
 */
export const FreeZoneAccessSchema = z.object({
  enabled: z.boolean().default(false),
  /** 这个时间之后注册的用户才有新人试用；null 表示不开新人试用 */
  trial_since: IsoTimeSchema.nullable().default(null),
  trial_hours: z.number().int().min(1).max(720).default(72),
  /** 0 表示不送开通礼 */
  vip_welcome_days: z.number().int().min(0).max(31).default(5),
  vip_weekly: FreeZoneVipWeeklySchema.default({}),
  prompt: FreeZoneAccessPromptSchema.default({}),
});

export const FreeZoneConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** 卡头规则文字，保留换行；前端最多显示三行 */
    rules_text: z.string().max(200).default(''),
    /** 福利期；为 null 时栏目不显示 */
    period: FreeZonePeriodSchema.nullable().default(null),
    scope: FreeZoneScopeSchema.default('all_cards'),
    candidates: z.array(FreeZoneCandidateSchema).max(50).default([]),
    screening: FreeZoneScreeningSchema.default({}),
    first_token: FreeZoneFirstTokenSchema.default({}),
    access: FreeZoneAccessSchema.default({}),
    usage_limit: FreeZoneUsageLimitSchema.default({}),
    /** 畅聊专用兜底；null 沿用模型目录的兜底（付费档位同一个） */
    fallback: FreeZoneFallbackSchema.nullable().default(null),
  })
  .superRefine((config, ctx) => {
    const ids = config.candidates.map((candidate) => candidate.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates'], message: '候选 id 重复' });
    }
    const models = config.candidates.map((candidate) => candidate.surplus_model.toLowerCase());
    if (new Set(models).size !== models.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates'],
        message: '同一个 Surplus 模型只能出现一次',
      });
    }
  });

export type FreeZoneCandidate = z.infer<typeof FreeZoneCandidateSchema>;
export type FreeZoneScreening = z.infer<typeof FreeZoneScreeningSchema>;
export type FreeZoneConfig = z.infer<typeof FreeZoneConfigSchema>;
export type FreeZoneAccess = z.infer<typeof FreeZoneAccessSchema>;
export type FreeZoneVipWeekly = z.infer<typeof FreeZoneVipWeeklySchema>;
export type FreeZoneUsageLimit = z.infer<typeof FreeZoneUsageLimitSchema>;
export type FreeZoneFallback = z.infer<typeof FreeZoneFallbackSchema>;
export type SurplusRouteObjective = z.infer<typeof SurplusRouteObjectiveSchema>;

export const DEFAULT_FREE_ZONE_CONFIG: FreeZoneConfig = FreeZoneConfigSchema.parse({});

/** 这个模型实际用的折扣底线：候选单独设了就用它，否则用统一值。 */
export function freeZoneDiscountFloor(
  screening: Pick<FreeZoneScreening, 'min_discount_pct'>,
  candidate: { min_discount_pct?: number | null } | null | undefined
): number {
  return candidate?.min_discount_pct ?? screening.min_discount_pct;
}

/** 这个免费模型每人每天的上限：模型自己设了用它，否则用全局；null 表示不限。 */
export function freeZoneTurnLimit(
  config: { usage_limit?: { turns_per_24h?: number | null } },
  model: { turns_per_24h?: number | null } | null | undefined
): number | null {
  return model?.turns_per_24h ?? config.usage_limit?.turns_per_24h ?? null;
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** ISO 周几（1–7）的中文名 */
export function freeZoneWeekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? `周${weekday}`;
}

function clockText(minuteOfDay: number): string {
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/**
 * 会员畅聊日的人话写法（北京时间）：「周四 12:00 至次日 03:00」；
 * 当天结束写「周四 12:00 至 23:00」，跨两天以上写结束那天的周几。运营平台和前端共用。
 */
export function formatVipWeeklyWindow(weekly: {
  weekday: number;
  start_minute: number;
  duration_minutes: number;
}): string {
  const end = weekly.start_minute + weekly.duration_minutes;
  const dayOffset = Math.floor(end / 1440);
  const endText =
    dayOffset === 0
      ? ` ${clockText(end)}`
      : dayOffset === 1
        ? `次日 ${clockText(end)}`
        : `${freeZoneWeekdayLabel(((weekly.weekday - 1 + dayOffset) % 7) + 1)} ${clockText(end)}`;
  return `${freeZoneWeekdayLabel(weekly.weekday)} ${clockText(weekly.start_minute)} 至${endText}`;
}

// ── 公开契约 ──────────────────────────────────────────────────────────────

export const PublicFreeZoneModelSchema = z.object({
  id: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  tagline: z.string(),
  benchmark_tier: ModelCatalogTierKeySchema,
  /** 划线原价：对标档位当前的星尘价 */
  original_credits: z.number().int().nonnegative(),
  /** 这个模型有每人每天上限（不下发具体数字）；旧后端不返回 */
  limited: z.boolean().optional(),
  /** 这个用户已用满上限：什么时候恢复；没用满为 null */
  limit_resets_at: IsoTimeSchema.nullable().optional(),
});

export const FREE_ZONE_ACCESS_VIA = ['welfare', 'trial', 'vip_welcome', 'vip_weekly'] as const;
export type FreeZoneAccessVia = (typeof FREE_ZONE_ACCESS_VIA)[number];

export const FREE_ZONE_AUDIENCES = ['everyone', 'trial', 'vip', 'non_vip'] as const;
export type FreeZoneAudience = (typeof FREE_ZONE_AUDIENCES)[number];

/** 开放规则里前端写文案要用的数字；时间一律北京时间 */
export const PublicFreeZoneAccessSchema = z.object({
  /** 此刻为什么对这个用户开放；未开放为 null */
  via: z.enum(FREE_ZONE_ACCESS_VIA).nullable(),
  /** 按谁来展示：福利期 everyone，新人试用期 trial，其余按是否会员 */
  audience: z.enum(FREE_ZONE_AUDIENCES),
  trial_hours: z.number().int().positive(),
  vip_welcome_days: z.number().int().nonnegative(),
  vip_weekly: z.object({
    weekday: z.number().int().min(1).max(7),
    start_minute: z.number().int().min(0).max(1439),
    duration_minutes: z.number().int().positive(),
  }),
});

const PublicFreeZoneBase = {
  rules: z.string(),
  models: z.array(PublicFreeZoneModelSchema),
  /** 按身份开放的说明；只有福利期的旧后端不返回 */
  access: PublicFreeZoneAccessSchema.optional(),
};

/** 当前或下一个会员畅聊日 */
const VipDayWindowSchema = z.object({
  open: z.boolean(),
  starts_at: IsoTimeSchema,
  ends_at: IsoTimeSchema,
});

/**
 * 栏目状态。open 写结束时间；未开放按原因区分：
 * not_started 写开始时间，own_card_only 是范围只限自创卡而当前是别人的卡，no_models 是没有在架模型；
 * vip_waiting 是会员等下一个畅聊日（写开始时间），vip_only 是非会员（会员专享，带当前/下一个畅聊日）。
 */
export const PublicFreeZoneSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), ends_at: IsoTimeSchema, ...PublicFreeZoneBase }),
  z.object({ state: z.literal('not_started'), starts_at: IsoTimeSchema, ...PublicFreeZoneBase }),
  z.object({ state: z.literal('own_card_only'), ...PublicFreeZoneBase }),
  z.object({ state: z.literal('no_models'), ...PublicFreeZoneBase }),
  z.object({ state: z.literal('vip_waiting'), starts_at: IsoTimeSchema, ...PublicFreeZoneBase }),
  z.object({ state: z.literal('vip_only'), vip_day: VipDayWindowSchema, ...PublicFreeZoneBase }),
]);

export type PublicFreeZoneModel = z.infer<typeof PublicFreeZoneModelSchema>;

/**
 * 选中的免费模型今天用满了、本轮自动换掉时，SSE start 带给前端的轻提示（回复下面一行小字）。
 * 下架、栏目关闭换模型不带这个（另有分隔线或公告）。
 */
export interface FreeZoneLimitSwitch {
  from_name: string;
  to_name: string;
  /** 免费模型都用满了，换成了付费默认模型 */
  to_paid: boolean;
  /** 原来那个模型什么时候恢复 */
  resets_at: string | null;
}
export type PublicFreeZoneAccess = z.infer<typeof PublicFreeZoneAccessSchema>;
export type PublicFreeZone = z.infer<typeof PublicFreeZoneSchema>;
export type PublicFreeZoneState = PublicFreeZone['state'];
