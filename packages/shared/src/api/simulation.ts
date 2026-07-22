import { z } from 'zod';

const UuidSchema = z.string().uuid();
const CardHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const SimulationChatRequestSchema = z
  .object({
    card_hash: CardHashSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    user_message: z.string().min(1).max(20_000),
    conversation_id: UuidSchema.optional(),
    model_id: z.string().trim().min(1).max(64).optional(),
    preset_id: UuidSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.card_hash) === Boolean(value.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'card_hash and name are mutually exclusive; provide exactly one',
        path: ['card_hash'],
      });
    }
  });

export type SimulationChatRequest = z.infer<typeof SimulationChatRequestSchema>;

export interface SimulationEffectiveConfig {
  model_id: string;
  model_name: string;
  preset_id: string | null;
  preset_version: number | string | null;
  sampling: Record<string, unknown>;
}

export interface SimulationChatData {
  conversation_id: string;
  chat_log_id: string;
  character_id: string;
  card_hash: string;
  character_name: string;
  assistant_reply: string;
  effective_config: SimulationEffectiveConfig;
}

export interface SimulationCardCandidate {
  character_id: string;
  card_hash: string;
}

export interface SimulationNameConflictResponse {
  success: false;
  error: {
    code: 'AMBIGUOUS_CHARACTER_NAME';
    message: string;
    candidates: SimulationCardCandidate[];
  };
}
