import { z } from 'zod';

export const AdminImageTextModelTestRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    api_key: z.string().trim().min(1).max(4096),
    model: z.string().trim().min(1).max(256),
  })
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value.url);
      if (url.protocol !== 'https:') throw new Error('not https');
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'URL must be a valid HTTPS address',
      });
    }
  });

export type AdminImageTextModelTestRequest = z.infer<typeof AdminImageTextModelTestRequestSchema>;

export interface AdminImageTextModelTestResponse {
  ok: true;
  model: string;
  latency_ms: number;
}
