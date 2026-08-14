import { z } from 'zod';

export type GenerationPhase = 'idle' | 'started' | 'streaming' | 'finished' | 'aborted';

export const GenerationPhaseSchema = z.enum([
  'idle',
  'started',
  'streaming',
  'finished',
  'aborted',
]);

export type STMirrorState = {
  userId: string;
  currentCharacterId: number | null;
  currentChatId: string | null;
  currentPresetName: string | null;
  currentModel: string | null;
  generationPhase: GenerationPhase;
  messageCount: number;
  lastUpdatedAt: number;
};

export const STMirrorStateSchema = z.object({
  userId: z.string(),
  currentCharacterId: z.number().nullable(),
  currentChatId: z.string().nullable(),
  currentPresetName: z.string().nullable(),
  currentModel: z.string().nullable(),
  generationPhase: GenerationPhaseSchema,
  messageCount: z.number(),
  lastUpdatedAt: z.number(),
});
