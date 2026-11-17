import { z } from 'zod';

export const CHAT_FEEDBACK_REASONS = [
  { id: 'out_of_character', label: '不符合人设' },
  { id: 'controls_player', label: '替我说话或行动' },
  { id: 'lacks_tension', label: '没有性张力' },
  { id: 'ignores_instructions', label: '没按我的要求' },
  { id: 'repetitive', label: '重复啰嗦' },
  { id: 'dull_plot', label: '剧情没意思' },
  { id: 'slow_or_error', label: '回复慢或出错' },
  { id: 'other', label: '其他' },
] as const;
export const ChatFeedbackReasonSchema = z.enum([
  'out_of_character',
  'controls_player',
  'lacks_tension',
  'ignores_instructions',
  'repetitive',
  'dull_plot',
  'slow_or_error',
  'other',
]);
export type ChatFeedbackReason = z.infer<typeof ChatFeedbackReasonSchema>;
const ReasonsSchema = z
  .array(ChatFeedbackReasonSchema)
  .max(8)
  .refine((items) => new Set(items).size === items.length, '反馈原因不能重复');
export const SaveChatFeedbackRequestSchema = z
  .object({
    expected_version: z.number().int().min(0).max(2147483647),
    reasons: ReasonsSchema.default([]),
    detail: z.string().trim().max(500).default(''),
  })
  .strict();
export type SaveChatFeedbackRequest = z.infer<typeof SaveChatFeedbackRequestSchema>;
export const ChatFeedbackSchema = z
  .object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    message_id: z.string().uuid(),
    edit_version: z.number().int().nonnegative(),
    reasons: ReasonsSchema,
    detail: z.string().max(500),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ChatFeedback = z.infer<typeof ChatFeedbackSchema>;
export const GetChatFeedbackDataSchema = z
  .object({ feedback: ChatFeedbackSchema.nullable() })
  .strict();
export type GetChatFeedbackData = z.infer<typeof GetChatFeedbackDataSchema>;
export const SaveChatFeedbackDataSchema = z.object({ feedback: ChatFeedbackSchema }).strict();
export type SaveChatFeedbackData = z.infer<typeof SaveChatFeedbackDataSchema>;
