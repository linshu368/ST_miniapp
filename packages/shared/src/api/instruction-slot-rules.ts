import { z } from 'zod';

/**
 * One independently published platform-instruction slot. This is runtime
 * configuration rather than a browser DTO: rule text must never cross an
 * HTTP/SSE boundary.
 */
export const InstructionSlotRulesSchema = z
  .object({
    on_first_two_turns: z.string().trim().min(1),
    on_later_turns: z.string().trim().min(1),
    off: z.string().trim().min(1),
  })
  .strict();

export type InstructionSlotRules = z.infer<typeof InstructionSlotRulesSchema>;
