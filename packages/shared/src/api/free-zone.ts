import { z } from 'zod';
import { ModelCatalogTierKeySchema } from './model-tier-key.js';

/**
 * 畅聊栏目（免费模型）：运营配置与公开契约。
 *
 * 模型全部来自 Surplus 低价池，由后台评估任务按「官方数据初筛 + 在架业务数据」自动上下架；
 * 运营只维护候选池和门槛。门槛字段为 null 表示这一项不检查。
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

/** 免费模型 id：候选池和模型目录「免费畅聊」板块共用 */
export const FreeZoneModelIdSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^free-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, '免费模型 id 必须以 free- 开头');

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
   * 这个模型单独的折扣底线（%）；留空用初筛里的统一底线。初筛、派单探测和真实请求的
   * X-Min-Discount 都按它。有些模型原价本来就低，可以放宽一点。
   */
  min_discount_pct: z.number().int().min(1).max(100).nullable().default(null),
});

export const FreeZoneScreeningSchema = z.object({
  /** 统一折扣底线，同时作为请求时的 X-Min-Discount；候选单独设了就按候选的 */
  min_discount_pct: z.number().int().min(1).max(100).default(85),
  min_qualified_offers: z.number().int().min(1).max(10_000).nullable().default(5),
  min_realized_discount_pct: PercentSchema.nullable().default(85),
  min_uptime_pct: PercentSchema.nullable().default(95),
  max_ttft_p50_ms: DurationMsSchema.nullable().default(3000),
  max_ttft_p90_ms: DurationMsSchema.nullable().default(7500),
  min_tps: z.number().positive().max(100_000).nullable().default(30),
  /** 供应商近 24 小时缓存命中率下限（Surplus 统计的是这家所有买家的命中率）；命中低，同样的对话实际花费更高 */
  min_cache_hit_rate_pct: PercentSchema.nullable().default(70),
  min_samples: z.number().int().nonnegative().nullable().default(200),
  /**
   * 选供应商时的价格分档倍数：和最便宜的达标供应商价格差不到这个倍数的算同一档、比首字；
   * 更贵的档只有便宜档没人时才考虑。
   */
  price_band_ratio: z.number().min(1).max(100).default(3),
  /**
   * 屏蔽的渠道（Surplus 供应商名，不分大小写）：这些渠道的报价一律不参与初筛和挑供应商，
   * 所有模型都一样。在架模型下一轮复核时自动换到别家，没有别家就下架。
   * 例如 dashscope-cn 会因内容审核把角色扮演回复写到一半掐断。
   */
  blocked_providers: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  /**
   * 派单探测：评估时对在架、准备上架的模型，用选定的供应商带折扣底线真发一个只要几个字的请求。
   * 派不出去（折扣底线达不到、没有可用卖家）就当这家不达标——订单簿上的折扣和 Surplus
   * 派单时估算的折扣可能不一样。
   */
  probe_enabled: z.boolean().default(true),
  /** 探测首字上限；留空只记录不检查 */
  max_probe_ttft_ms: DurationMsSchema.nullable().default(null),
});

/**
 * 在架质量：两类原因，处理不同。
 * - 质量原因（不可接受）：最近的真实轮次里中断率或不可用率超过上限 → 直接下架并停着，
 *   评估不会自动放回来，运营点「立即上架」才回来。每 30 分钟评估时按这个模型过去
 *   QUALITY_WINDOW_HOURS 小时的全部轮次算（只算这次上架之后的），至少 QUALITY_MIN_TURNS 轮才判断。
 * - 价格原因（多半是暂时的）：真实请求被 Surplus 拒绝派单的比例超过上限 → 当场下架，
 *   冷却 relist.price_cooldown_minutes 后照常由评估按报价重新上架。
 * 上限留空（null）表示这一项不检查。
 */
export const FreeZoneOnShelfSchema = z.object({
  /** 中断率：开始出字后没写完就断（不含用户点停、内容审核），占免费模型自己交付轮次的比例 */
  max_interrupted_pct: PercentSchema.nullable().default(8),
  /**
   * 不可用率：超时兜底 + 超时——等到「启动兜底等待」免费模型还没出字（之后才报错也算），
   * 或最后什么都没收到，占全部轮次的比例。报错、空回复后立刻兜底的不算（影响小）。
   */
  max_unusable_pct: PercentSchema.nullable().default(10),
  /**
   * 派不出去率：真实请求被 Surplus 拒绝派单（折扣底线达不到、没有可用卖家，404/503）的比例。
   * 不等评估：每次请求后按这个模型最近 20 次主请求算，至少 10 次拿到响应、超过上限就当场下架。
   * 派单探测只发几个字，可能派得出去；几万 token 的真实对话却可能几乎全被拒。
   */
  max_unroutable_pct: PercentSchema.nullable().default(50),
});

/**
 * 质量判断看过去多少小时、至少多少轮才判断（固定值，不做运营参数）。
 * 按时间而不是「最近 N 轮」：最近 100 轮里一两个对话一直出问题、又聊得勤的用户就能把模型拉下架
 * （11-17 3 Flash Preview、3.1 Flash Lite 都是这样），按 3 小时全部轮次算会稀释掉。
 */
export const QUALITY_WINDOW_HOURS = 3;
export const QUALITY_MIN_TURNS = 30;

export const FreeZoneRelistSchema = z.object({
  /**
   * 价格原因下架（官方报价没了、派单探测派不出去、真实请求派不出去）后多久再评估。
   * 之后每 30 分钟一轮，报价达标就直接上架。质量原因下架不看这个：一直停着等运营上架。
   */
  price_cooldown_minutes: z.number().int().min(0).max(43_200).default(60),
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
    on_shelf: FreeZoneOnShelfSchema.default({}),
    relist: FreeZoneRelistSchema.default({}),
    first_token: FreeZoneFirstTokenSchema.default({}),
    access: FreeZoneAccessSchema.default({}),
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
export type FreeZoneOnShelf = z.infer<typeof FreeZoneOnShelfSchema>;
export type FreeZoneRelist = z.infer<typeof FreeZoneRelistSchema>;
export type FreeZoneConfig = z.infer<typeof FreeZoneConfigSchema>;
export type FreeZoneAccess = z.infer<typeof FreeZoneAccessSchema>;
export type FreeZoneVipWeekly = z.infer<typeof FreeZoneVipWeeklySchema>;

export const DEFAULT_FREE_ZONE_CONFIG: FreeZoneConfig = FreeZoneConfigSchema.parse({});

/** 这个模型实际用的折扣底线：候选单独设了就用它，否则用统一值。 */
export function freeZoneDiscountFloor(
  screening: Pick<FreeZoneScreening, 'min_discount_pct'>,
  candidate: { min_discount_pct?: number | null } | null | undefined
): number {
  return candidate?.min_discount_pct ?? screening.min_discount_pct;
}

/** 把初筛门槛里的折扣底线换成这个模型的，其余照旧——下游一律读 min_discount_pct。 */
export function freeZoneRulesFor(
  screening: FreeZoneScreening,
  candidate: { min_discount_pct?: number | null } | null | undefined
): FreeZoneScreening {
  return { ...screening, min_discount_pct: freeZoneDiscountFloor(screening, candidate) };
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
export type PublicFreeZoneAccess = z.infer<typeof PublicFreeZoneAccessSchema>;
export type PublicFreeZone = z.infer<typeof PublicFreeZoneSchema>;
export type PublicFreeZoneState = PublicFreeZone['state'];
