import { z } from 'zod';

export const CREATOR_ANALYTICS_PERIODS = [
  { id: 'all', label: '累计' },
  { id: '7d', label: '近7天' },
  { id: '30d', label: '近30天' },
] as const;
export const CreatorAnalyticsQuerySchema = z
  .object({
    section: z.enum(['overview', 'works', 'rewards', 'feedback', 'characters']).default('overview'),
    period: z.enum(['all', '7d', '30d']).default('all'),
    character_id: z.string().uuid().optional(),
    sort: z.enum(['players', 'earned', 'newest']).default('players'),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    page_size: z.coerce.number().int().min(1).max(20).default(4),
    /** Keep the end of the reporting window stable while browsing subsequent pages. */
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type CreatorAnalyticsQuery = z.infer<typeof CreatorAnalyticsQuerySchema>;
export type CreatorAnalyticsPeriod = CreatorAnalyticsQuery['period'];
const count = z.number().int().nonnegative();
const amount = z.number().finite();
export const CreatorAnalyticsCardSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  cover_url: z.string().nullable(),
  visibility: z.enum(['private', 'public']),
  state: z.enum(['draft', 'ready']),
  created_at: z.string(),
});
export const CreatorAnalyticsWorkSchema = CreatorAnalyticsCardSchema.extend({
  stats: z.object({ players: count, rounds: count, earned: amount }),
});
export const CreatorAnalyticsRewardSchema = z.object({
  id: z.string(),
  character_id: z.string().uuid(),
  name: z.string(),
  amount,
  occurred_at: z.string(),
  kind: z.enum(['credit', 'reversal']),
});
export const CreatorAnalyticsFeedbackSchema = z.object({
  id: z.string().uuid(),
  character_id: z.string().uuid(),
  name: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.string(),
});
export const CreatorAnalyticsSummarySchema = z.object({
  players: count,
  rounds: count,
  earned: amount,
  todayEarned: amount,
  deepPlayers: count,
  returningPlayers: count,
  /** Current retained interactions, independent of the selected usage period. */
  likes: count,
  favorites: count,
  /** Public comments within the selected reporting period. */
  comments: count,
});
const meta = { as_of: z.string(), page: count, page_size: count, total: count };
export const CreatorAnalyticsOverviewSchema = z.object({
  section: z.literal('overview'),
  as_of: z.string(),
  card_count: count,
  selected: CreatorAnalyticsCardSchema.nullable(),
  summary: CreatorAnalyticsSummarySchema,
  works: z.array(CreatorAnalyticsWorkSchema).max(3),
  works_total: count,
  rewards: z.array(CreatorAnalyticsRewardSchema).max(3),
  rewards_total: count,
  feedback: z.array(CreatorAnalyticsFeedbackSchema).max(3),
  feedback_total: count,
});
export const CreatorAnalyticsWorksSchema = z.object({
  section: z.literal('works'),
  ...meta,
  items: z.array(CreatorAnalyticsWorkSchema).max(20),
});
export const CreatorAnalyticsRewardsSchema = z.object({
  section: z.literal('rewards'),
  ...meta,
  items: z.array(CreatorAnalyticsRewardSchema).max(20),
});
export const CreatorAnalyticsFeedbackPageSchema = z.object({
  section: z.literal('feedback'),
  ...meta,
  items: z.array(CreatorAnalyticsFeedbackSchema).max(20),
});
export const CreatorAnalyticsCharactersSchema = z.object({
  section: z.literal('characters'),
  ...meta,
  items: z.array(CreatorAnalyticsCardSchema).max(20),
});
export const CreatorAnalyticsDataSchema = z.discriminatedUnion('section', [
  CreatorAnalyticsOverviewSchema,
  CreatorAnalyticsWorksSchema,
  CreatorAnalyticsRewardsSchema,
  CreatorAnalyticsFeedbackPageSchema,
  CreatorAnalyticsCharactersSchema,
]);
export type CreatorAnalyticsData = z.infer<typeof CreatorAnalyticsDataSchema>;
export type CreatorAnalyticsOverview = z.infer<typeof CreatorAnalyticsOverviewSchema>;
export type CreatorAnalyticsCard = z.infer<typeof CreatorAnalyticsCardSchema>;
export type CreatorAnalyticsWork = z.infer<typeof CreatorAnalyticsWorkSchema>;
export type CreatorAnalyticsReward = z.infer<typeof CreatorAnalyticsRewardSchema>;
export type CreatorAnalyticsFeedback = z.infer<typeof CreatorAnalyticsFeedbackSchema>;
