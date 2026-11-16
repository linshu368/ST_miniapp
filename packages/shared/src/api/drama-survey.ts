import { z } from 'zod';

/**
 * 短剧原因问卷（一次性）：只问本机有过有效观看的用户，判断不继续看的主因是耗时还是内容。
 * 题目与选项写死在这里，不走运营配置。库里只存选项编码，展示文案可以改；改了题意就换 survey key。
 */
export const DRAMA_SURVEY_KEY = 'drama_reason_v1';
/** 任意一个对话聊满这么多轮（用户发出且 AI 回复完成）后弹出。 */
export const DRAMA_SURVEY_TRIGGER_ROUNDS = 4;
/** 提交后发放的 bonus 星尘，与签到等奖励同一个余额。 */
export const DRAMA_SURVEY_REWARD_CREDITS = 200;
export const DRAMA_SURVEY_MAX_REASONS = 2;

/** 两道选择题都有「其他」，固定排在最后，不参与随机排序。 */
export const DRAMA_SURVEY_OTHER_REASON = { id: 'other', label: '其他' } as const;

/** Q2a：先答。 */
export const DRAMA_SURVEY_OPEN_QUESTION = '平时较少点开短剧的原因是？';
export const DRAMA_SURVEY_OPEN_REASONS = [
  { id: 'chat_only', label: '我来这里主要是聊天，不想看视频' },
  { id: 'distrust_ai', label: '对 AI 做的短剧没兴趣 / 觉得质量不会好' },
  { id: 'cover_unappealing', label: '封面和标题不吸引我' },
  { id: 'not_into_dramas', label: '平时就不看短剧' },
] as const;

/** Q2b：Q2a 选过后才能答。 */
export const DRAMA_SURVEY_WATCH_QUESTION = '让你没有多看（或想吐槽）的主要原因是？';
export const DRAMA_SURVEY_WATCH_REASONS = [
  { id: 'slow_start', label: '打开要等很久才开始播' },
  { id: 'stutter', label: '播放卡顿，拖进度要缓冲' },
  { id: 'boring_plot', label: '剧情无聊、套路化' },
  { id: 'ai_visuals', label: 'AI 画面看着别扭（表情僵、动作怪、人物前后不一致）' },
  { id: 'genre_mismatch', label: '题材不是我喜欢的' },
  { id: 'too_few_episodes', label: '集数太少 / 不更新' },
] as const;

/** Q3：选填。 */
export const DRAMA_SURVEY_COMMENT_QUESTION = '一句话说说你对短剧的吐槽或期待';

const ids = (items: readonly { id: string }[]) =>
  new Set<string>([...items.map((item) => item.id), DRAMA_SURVEY_OTHER_REASON.id]);
const OPEN_IDS = ids(DRAMA_SURVEY_OPEN_REASONS);
const WATCH_IDS = ids(DRAMA_SURVEY_WATCH_REASONS);

function reasonList(allowed: Set<string>) {
  return z
    .array(z.string())
    .min(1, '请至少选一项')
    .max(DRAMA_SURVEY_MAX_REASONS)
    .refine((items) => new Set(items).size === items.length, '选项不能重复')
    .refine((items) => items.every((item) => allowed.has(item)), '选项无效');
}
const otherText = z.string().trim().max(200).default('');

/** 本机追剧记录里的观看深度，随答卷存下，用于按轻度/深度用户拆分答案。 */
export const DramaSurveyEngagementSchema = z
  .object({
    engaged_dramas: z.number().int().min(1).max(200),
    max_episode: z.number().int().min(1).max(100000),
  })
  .strict();
export type DramaSurveyEngagement = z.infer<typeof DramaSurveyEngagementSchema>;

export const SubmitDramaSurveyRequestSchema = z
  .object({
    open_reasons: reasonList(OPEN_IDS),
    open_other_text: otherText,
    watch_reasons: reasonList(WATCH_IDS),
    watch_other_text: otherText,
    comment: z.string().trim().max(500).default(''),
    platform: z.string().trim().max(32).default(''),
    engagement: DramaSurveyEngagementSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const other = DRAMA_SURVEY_OTHER_REASON.id;
    if (value.open_other_text && !value.open_reasons.includes(other))
      ctx.addIssue({
        code: 'custom',
        path: ['open_other_text'],
        message: '只有选了「其他」才能填写说明',
      });
    if (value.watch_other_text && !value.watch_reasons.includes(other))
      ctx.addIssue({
        code: 'custom',
        path: ['watch_other_text'],
        message: '只有选了「其他」才能填写说明',
      });
  });
export type SubmitDramaSurveyRequest = z.input<typeof SubmitDramaSurveyRequestSchema>;
export type ParsedSubmitDramaSurveyRequest = z.output<typeof SubmitDramaSurveyRequestSchema>;

export const DismissDramaSurveyRequestSchema = z
  .object({
    platform: z.string().trim().max(32).default(''),
    engagement: DramaSurveyEngagementSchema,
  })
  .strict();
export type DismissDramaSurveyRequest = z.input<typeof DismissDramaSurveyRequestSchema>;
export type ParsedDismissDramaSurveyRequest = z.output<typeof DismissDramaSurveyRequestSchema>;

export const DramaSurveyStatusDataSchema = z
  .object({
    survey_key: z.string(),
    /** 开关打开且这个账号还没领过奖励。是否看过短剧、是否叉掉过都只在前端本机判断。 */
    eligible: z.boolean(),
    reward_credits: z.number().int().positive(),
  })
  .strict();
export type DramaSurveyStatusData = z.infer<typeof DramaSurveyStatusDataSchema>;

export const SubmitDramaSurveyDataSchema = z
  .object({
    status: z.enum(['rewarded', 'already_rewarded']),
    credits: z.number().int().positive(),
  })
  .strict();
export type SubmitDramaSurveyData = z.infer<typeof SubmitDramaSurveyDataSchema>;
