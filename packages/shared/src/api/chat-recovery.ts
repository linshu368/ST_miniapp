/**
 * 运营托管配置 chat_recovery_config：聊天回复「出字之后」出问题时启用兜底。
 *
 * - 中断：出字后连续 stall_ms 没有新字（或流里先出现异常）即判中断。
 * - 拒答：正文照常输出，正文前 check_chars 个字里命中词池任一关键词即判拒答。
 * - 两种情况都由兜底模型从头重写：兜底出第一段正文时擦掉这条回复已显示的正文与思考。
 * - 兜底模型 fallback_first_token_ms 内没出第一个字就放弃；兜底不再做兜底。
 *
 * 没配或配坏时后端两个开关都按关闭处理并记 warn（代码里不放默认词池）。
 */
import { z } from 'zod';

export const CHAT_RECOVERY_CONFIG_KEY = 'chat_recovery_config';

const KeywordSchema = z.string().trim().min(1, '关键词不能为空').max(40, '关键词最多 40 个字符');

export const ChatRecoveryConfigSchema = z
  .object({
    /** 兜底模型出第一个字的时限（毫秒） */
    fallback_first_token_ms: z.number().int().min(1_000).max(20_000),
    interruption: z
      .object({
        enabled: z.boolean(),
        /** 出字后连续多久没有新字判为中断（毫秒） */
        stall_ms: z.number().int().min(1_000).max(60_000),
      })
      .strict(),
    refusal: z
      .object({
        enabled: z.boolean(),
        /** 只在正文前多少个字里找关键词（正文照常输出，不压） */
        check_chars: z.number().int().min(5).max(200),
        /** 子串匹配、不区分大小写；不要放「抱歉」这类剧情里也常见的词 */
        keywords: z.array(KeywordSchema).max(500),
      })
      .strict(),
  })
  .strict();
export type ChatRecoveryConfig = z.infer<typeof ChatRecoveryConfigSchema>;

/** 运营平台新建这项配置时的初始值；后端读不到配置时不使用它，而是视为关闭。 */
export const INITIAL_CHAT_RECOVERY_CONFIG: ChatRecoveryConfig = {
  fallback_first_token_ms: 3_000,
  interruption: { enabled: false, stall_ms: 3_000 },
  refusal: { enabled: false, check_chars: 30, keywords: [] },
};
