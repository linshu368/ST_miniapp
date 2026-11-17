import { z } from 'zod';

/**
 * 增长弹窗：到点后在平静时刻弹出的进群 / VIP 邀请。
 * 服务端只返回当下「前置条件与展示上限都满足」的弹窗；轮数门槛由前端用
 * total_rounds + 本次打开新完成的轮数判断，避免每完成一轮都请求一次。
 * VIP 弹窗的时机跟着畅聊走（见 VipPromptContext），at_rounds 由服务端按场景给出。
 */
export const GROWTH_PROMPT_KINDS = ['community', 'vip'] as const;
export type GrowthPromptKind = (typeof GROWTH_PROMPT_KINDS)[number];

export const GROWTH_PROMPT_EVENTS = ['shown', 'accepted', 'dismissed'] as const;
export type GrowthPromptEvent = (typeof GROWTH_PROMPT_EVENTS)[number];

export interface CommunityGrowthPrompt {
  kind: 'community';
  at_rounds: number;
  reward_credits: number;
  telegram_url: string;
  /** openTelegramLink 不可用时让用户手动搜索的账号 */
  fallback_handle: string;
}

/**
 * VIP 弹窗场景（畅聊按身份开放之后）：
 * - trial_ended：新人试用刚结束，完成被切到付费的那一轮后弹；
 * - welfare_ended：畅聊福利期刚结束，同上，只弹一次；
 * - vip_day：会员畅聊日开放中，非会员打开小程序时弹。
 */
export const VIP_PROMPT_CONTEXTS = ['trial_ended', 'welfare_ended', 'vip_day'] as const;
export type VipPromptContext = (typeof VIP_PROMPT_CONTEXTS)[number];

export interface VipGrowthPrompt {
  kind: 'vip';
  at_rounds: number;
  price_cents: number;
  duration_days: number;
  /** 开通立得的星尘（专项 + 通用合计） */
  bonus_credits: number;
  /** 会员每日签到可领的星尘 */
  checkin_daily_credits: number;
  /** 以下字段旧后端（累计 50 轮弹窗）不返回 */
  context?: VipPromptContext;
  /** bonus_credits 里的通用星尘部分，其余是专项 */
  bonus_main_credits?: number;
  /** 开通/续费立享几天畅聊 */
  welcome_days?: number;
  /** 会员每周畅聊日（北京时间） */
  vip_day?: { weekday: number; start_minute: number; duration_minutes: number };
}

export type GrowthPrompt = CommunityGrowthPrompt | VipGrowthPrompt;

// ==== GET /api/growth/prompts ====
export interface GetGrowthPromptsData {
  /** 服务端累计成功轮数（不分角色） */
  total_rounds: number;
  /** 按优先级排序：进群在前，VIP 在后 */
  prompts: GrowthPrompt[];
}

// ==== POST /api/growth/prompts/events ====
export const RecordGrowthPromptEventRequestSchema = z
  .object({
    kind: z.enum(GROWTH_PROMPT_KINDS),
    event: z.enum(GROWTH_PROMPT_EVENTS),
  })
  .strict();
export type RecordGrowthPromptEventRequest = z.infer<typeof RecordGrowthPromptEventRequestSchema>;

export interface RecordGrowthPromptEventData {
  /** shown 超出上限或间隔时为 false，前端不应再弹 */
  recorded: boolean;
}
