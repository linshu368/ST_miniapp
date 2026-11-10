/**
 * 会话长期记忆（前情档案）的运营配置契约。
 *
 * 两个 managed config：参数（JSON）与压缩 prompt（文本）。Backend 读取、Admin 编辑与
 * CLI 共用这里的 schema 与默认值，不各自维护一份。
 */
import { z } from 'zod';
import { DEFAULT_STORY_MEMORY_PROMPT } from './story-memory-prompt';

export { DEFAULT_STORY_MEMORY_PROMPT };

export const STORY_MEMORY_CONFIG_KEY = 'story_memory_config';
export const STORY_MEMORY_PROMPT_KEY = 'story_memory_prompt';

/**
 * 用户只能编辑/删除最近 10 轮。保底保留轮数必须更大，被压缩的区间才永远不会再被修改，
 * 也就不需要"编辑旧历史后重新压缩"的机制。
 */
export const STORY_MEMORY_MIN_KEEP_TURNS_FLOOR = 11;

export const StoryMemoryConfigSchema = z
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
    /** 压缩模型（OpenRouter 模型 ID），与聊天兜底模型相互独立 */
    model_id: z.string().trim().min(1, '压缩模型不能为空').max(200),
    /** OpenRouter 供应商优先顺序（order + allow_fallbacks）；为空时交给 OpenRouter 默认路由 */
    preferred_providers: z.array(z.string().trim().min(1).max(80)).max(5),
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
export type StoryMemoryConfig = z.infer<typeof StoryMemoryConfigSchema>;

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
  // 2026-11-10 生产兜底模型参数（llm_model_catalog v99：fallback_model_id + fallback_provider_routes）。
  // 显式写死而不是跟随兜底，以后换更便宜的压缩模型不影响聊天兜底。
  model_id: 'deepseek/deepseek-v4.1-flash-1017',
  preferred_providers: ['Together', 'crusoe'],
  temperature: 0.3,
};

export const STORY_MEMORY_PROMPT_PLACEHOLDERS = [
  '{{old_memory}}',
  '{{new_history}}',
  '{{recent_context}}',
  '{{character_info}}',
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
