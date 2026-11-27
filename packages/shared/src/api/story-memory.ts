/**
 * 会话长期记忆（前情档案）的运营配置契约。
 *
 * 两个 managed config：参数（JSON）与压缩 prompt（文本）。Backend 读取、Admin 编辑与
 * CLI 共用这里的 schema 与默认值，不各自维护一份。
 */
import { z } from 'zod';
import { SurplusRouteObjectiveSchema } from './free-zone';
import { DEFAULT_STORY_MEMORY_PROMPT } from './story-memory-prompt';

export { DEFAULT_STORY_MEMORY_PROMPT };

export const STORY_MEMORY_CONFIG_KEY = 'story_memory_config';
export const STORY_MEMORY_PROMPT_KEY = 'story_memory_prompt';

/**
 * 用户只能编辑/删除最近 10 轮。保底保留轮数必须更大，被压缩的区间才永远不会再被修改，
 * 也就不需要"编辑旧历史后重新压缩"的机制。
 */
export const STORY_MEMORY_MIN_KEEP_TURNS_FLOOR = 11;

/** 2026-11-27 用户定：压缩改走 Surplus，路由与畅聊专用兜底（free_zone_config.fallback）取值相同，各存一份 */
const DEFAULT_STORY_MEMORY_SURPLUS = {
  model_id: 'deepseek-v4.1-flash-1017',
  // 11-27 用户定：强制关思考（默认 high 会想满几万字）、只用 mistral（直连实测能关思考，价格约为 DeepSeek 官方的 1/4）
  preferred_provider: 'mistral',
  pin_provider: true,
  reasoning_effort: 'none',
  route_objective: 'latency',
  price_tolerance_pct: 1000,
  // 后台任务不追求速度：关思考后首字就是读完 3 万多字 prompt 的时间（生产实测到 5.7 秒），15 秒没出字才放弃
  first_output_timeout_ms: 15000,
} as const;

/** Surplus 思考强度（模型说明：deepseek-v4.1-flash-1017 默认开、默认 high，支持 max/high/low/none） */
export const StoryMemoryReasoningEffortSchema = z.enum(['none', 'low', 'high', 'max']);

const StoryMemoryConfigObjectSchema = z
  .object({
    /** 关闭时停止生成与注入；截断不受影响 */
    enabled: z.boolean(),
    /** 高水位 U：窗口正文字数超过它触发截断 */
    high_watermark_chars: z.number().int().min(5000).max(500000),
    /** 低水位 L：截断后退到它以下 */
    low_watermark_chars: z.number().int().min(4000).max(500000),
    /** 保底：最近这么多轮永不截断，优先级高于 L */
    min_keep_turns: z.number().int().min(STORY_MEMORY_MIN_KEEP_TURNS_FLOOR).max(200),
    /** 保底之外可移除的轮数少于它时不截断，避免保底顶住时每轮都截断 */
    min_removable_turns: z.number().int().min(1).max(200),
    /** 档案字数上限，写进 prompt 并由代码硬校验 */
    memory_max_chars: z.number().int().min(1000).max(12000),
    /** 压缩时附带的窗口末尾只读轮数 */
    recent_context_turns: z.number().int().min(0).max(20),
    /** 待压缩区间超过它时按轮次边界分块 */
    chunk_chars: z.number().int().min(5000).max(100000),
    /** 压缩模型（Surplus 标准模型名），与聊天兜底模型相互独立 */
    model_id: z
      .string()
      .trim()
      .min(1, '压缩模型不能为空')
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Surplus 模型名只能是字母、数字和 . _ -'),
    /** 优先的 Surplus 供应商（provider_order：只排序、不限定）；null 不排序 */
    preferred_provider: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, '供应商名只能是小写字母、数字和 . _ -')
      .nullable(),
    /** true：只派给 preferred_provider（Surplus provider 白名单）；false：只排序、不限定 */
    pin_provider: z.boolean().default(false),
    /** 发给 Surplus 的思考强度；null 不发（按模型默认，1017 默认 high） */
    reasoning_effort: StoryMemoryReasoningEffortSchema.nullable().default(null),
    route_objective: SurplusRouteObjectiveSchema,
    /** 价格带：比最便宜的报价贵多少百分比以内都按路由目标排 */
    price_tolerance_pct: z.number().int().min(0).max(10_000),
    /** 多久没有任何输出（思考也算）就放弃这次调用；总超时另有 120 秒 */
    first_output_timeout_ms: z.number().int().min(1000).max(60_000),
    temperature: z.number().min(0).max(1.5),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.low_watermark_chars >= value.high_watermark_chars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['low_watermark_chars'],
        message: '低水位必须小于高水位',
      });
    }
  });

/**
 * 11-27 之前存的是 OpenRouter 形状（OpenRouter 模型 ID + preferred_providers）。原样按新契约校验会失败、
 * 整份回落到代码默认值（档案上限、保底轮数都会变），所以旧形状只换模型与路由，其余参数照用。
 */
function upgradeLegacyStoryMemoryConfig(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!('preferred_providers' in value)) return value;
  const { preferred_providers: _legacy, ...rest } = value as Record<string, unknown>;
  return {
    ...DEFAULT_STORY_MEMORY_SURPLUS,
    ...rest,
    model_id: DEFAULT_STORY_MEMORY_SURPLUS.model_id,
  };
}

export const StoryMemoryConfigSchema = z.preprocess(
  upgradeLegacyStoryMemoryConfig,
  StoryMemoryConfigObjectSchema
);
export type StoryMemoryConfig = z.infer<typeof StoryMemoryConfigObjectSchema>;

export const DEFAULT_STORY_MEMORY_CONFIG: StoryMemoryConfig = {
  enabled: true,
  // 2026-11-10 用户确认：下限 4 万、上限 6 万字正文；等待压缩时最多 7 万字。
  high_watermark_chars: 60000,
  low_watermark_chars: 40000,
  min_keep_turns: 15,
  min_removable_turns: 6,
  memory_max_chars: 5000,
  recent_context_turns: 8,
  // 不小于一次截断移出的量（U-L），每个周期只改写一次档案，减少多次改写带来的细节流失。
  chunk_chars: 40000,
  ...DEFAULT_STORY_MEMORY_SURPLUS,
  temperature: 0.3,
};

export const STORY_MEMORY_PROMPT_PLACEHOLDERS = [
  '{{old_memory}}',
  '{{new_history}}',
  '{{recent_context}}',
  '{{max_chars}}',
] as const;

export const STORY_MEMORY_PROMPT_MAX_CHARS = 20000;
const MIN_SECTIONS = 3;

/**
 * 模板里以 `## ` 开头的行就是输出必须包含的板块标题。运营改标题时校验自动跟随，
 * 不需要在 prompt 和参数两处同步维护。
 */
export function extractStoryMemorySections(template: string): string[] {
  return template
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## '))
    .map((line) => line.trim());
}

export const StoryMemoryPromptSchema = z
  .string()
  .trim()
  .min(1, '压缩 prompt 不能为空')
  .max(STORY_MEMORY_PROMPT_MAX_CHARS)
  .superRefine((value, ctx) => {
    for (const placeholder of STORY_MEMORY_PROMPT_PLACEHOLDERS) {
      if (!value.includes(placeholder)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `缺少占位符 ${placeholder}` });
      }
    }
    const sections = extractStoryMemorySections(value);
    if (sections.length < MIN_SECTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `至少需要 ${MIN_SECTIONS} 个以「## 」开头的输出板块标题`,
      });
    }
    if (new Set(sections).size !== sections.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '输出板块标题不能重复' });
    }
  });
