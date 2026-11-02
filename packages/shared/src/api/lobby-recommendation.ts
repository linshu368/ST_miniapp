import { z } from 'zod';

export const LOBBY_ROTATION_HEAD_SIZE = 12;

/** Rotation applies to everyone. Legacy gate fields remain compatible with stored configs. */
export const LobbyRotationConfigSchema = z.object({
  /** @deprecated Accepted for storage compatibility only; cannot disable rotation. */
  enabled: z.boolean().transform((): boolean => true),
  interval_hours: z.number().int().min(1).max(168),
  max_repeat: z.number().int().min(0).max(12),
  exploration_count: z.number().int().min(0).max(2),
  /** @deprecated Accepted for storage compatibility only; everyone receives rotation. */
  rollout_percent: z
    .number()
    .int()
    .min(0)
    .max(100)
    .transform((): number => 100),
});
export type LobbyRotationConfig = z.infer<typeof LobbyRotationConfigSchema>;
export const DEFAULT_LOBBY_ROTATION_CONFIG: LobbyRotationConfig = {
  enabled: true,
  interval_hours: 24,
  max_repeat: 2,
  exploration_count: 2,
  rollout_percent: 100,
};

export const LobbyRecommendationRequestSchema = z
  .object({
    action: z.enum(['open', 'resume', 'refresh', 'undo']),
    request_id: z.string().uuid(),
    expected_batch_id: z.string().uuid().nullable().optional(),
    restore_batch_id: z.string().uuid().nullable().optional(),
  })
  .strict();
export type LobbyRecommendationRequest = z.infer<typeof LobbyRecommendationRequestSchema>;

/** Private ordering only; presentation data still comes from the public character directory. */
export const LobbyRecommendationDataSchema = z.object({
  enabled: z.boolean(),
  degraded: z.boolean(),
  batch_id: z.string().uuid().nullable(),
  generated_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  character_ids: z.array(z.string().uuid()).max(10000),
  head_ids: z.array(z.string().uuid()).max(LOBBY_ROTATION_HEAD_SIZE),
  previous_batch_id: z.string().uuid().nullable(),
});
export type LobbyRecommendationData = z.infer<typeof LobbyRecommendationDataSchema>;

export const LobbyRecommendationExposuresSchema = z
  .object({
    batch_id: z.string().uuid(),
    character_ids: z.array(z.string().uuid()).min(1).max(40),
  })
  .strict();
export type LobbyRecommendationExposures = z.infer<typeof LobbyRecommendationExposuresSchema>;
export interface LobbyRecommendationExposuresData {
  accepted: number;
}
