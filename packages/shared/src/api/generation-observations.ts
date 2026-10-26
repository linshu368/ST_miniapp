import { z } from 'zod';

const DurationMs = z.number().finite().nonnegative().max(86_400_000);

/** Client display receipts gate new-turn billing; prices and completion remain server-owned. */
export const ReportFirstTokenRequestSchema = z
  .object({
    request_id: z.string().uuid(),
    assistant_message_id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    measurement_method: z.enum(['visible_dom_after_frame_v1', 'visible_dom_after_frame_v2']),
    outcome: z.enum(['observed', 'timed_out', 'not_observed']),
    first_token_visible_ms: DurationMs.nullable(),
    wait_finished_ms: DurationMs.nullable().optional(),
    request_dispatched_ms: DurationMs.nullable(),
    first_token_received_ms: DurationMs.nullable(),
    backgrounded: z.boolean(),
    reason: z
      .enum([
        'page_left',
        'cancelled',
        'superseded',
        'upstream_error',
        'not_visible',
        'server_timeout',
        'fallback_timeout',
        'primary_timeout',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.outcome === 'observed') !== (value.first_token_visible_ms !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['first_token_visible_ms'],
        message: 'Only an observed display has a visible-token duration',
      });
    }
    if (
      value.first_token_visible_ms !== null &&
      value.first_token_received_ms !== null &&
      value.first_token_received_ms > value.first_token_visible_ms
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['first_token_received_ms'],
        message: 'Reception cannot follow display',
      });
    }
  });

export type ReportFirstTokenRequest = z.infer<typeof ReportFirstTokenRequestSchema>;
export interface ReportFirstTokenData {
  recorded: boolean;
}
