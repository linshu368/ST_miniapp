import { z } from 'zod';

export const VideoPlazaPlaybackSchema = z.object({
  format: z.literal('hls'),
  play_url: z.string().url(),
  expires_at: z.string().datetime(),
  inline_manifest: z.string().max(16_384).optional(),
});
export type VideoPlazaPlayback = z.infer<typeof VideoPlazaPlaybackSchema>;

export const GetVideoPlazaDownloadDataSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('processing'), retry_after_ms: z.number().int().positive() }),
  z.object({
    status: z.literal('ready'),
    download_url: z.string().url(),
    expires_at: z.string().datetime(),
  }),
  z.object({ status: z.literal('failed'), error_code: z.string() }),
]);
export type GetVideoPlazaDownloadData = z.infer<typeof GetVideoPlazaDownloadDataSchema>;

export const VideoPlazaPlaybackObservationSchema = z
  .object({
    artifact_id: z.string().uuid(),
    stage: z.enum(['first_frame', 'seek', 'stall', 'playback']),
    outcome: z.enum(['succeeded', 'failed', 'interrupted']),
    duration_ms: z.number().finite().min(0).max(3_600_000),
    count: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type VideoPlazaPlaybackObservation = z.infer<typeof VideoPlazaPlaybackObservationSchema>;
