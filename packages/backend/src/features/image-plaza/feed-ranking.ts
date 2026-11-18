import { z } from 'zod';
import { getDomainDb } from '../../lib/supabase.js';
import { observation } from '../../platform/observability/runtime.js';

const resultSchema = z.object({
  ranking_revision: z.string().uuid(),
  count: z.number().int().nonnegative().max(100000),
});

/** Maintenance only: never put a full-directory rebuild on the feed request path. */
export async function rebuildImagePlazaFeedOrder() {
  return observation.observe(
    'image_plaza.feed.rebuild',
    async () => {
      const { data, error } = await getDomainDb('media_plaza')
        .rpc('rebuild_image_plaza_feed_order')
        .abortSignal(AbortSignal.timeout(65_000));
      if (error) throw new Error('image_plaza_feed_rebuild_failed', { cause: error });
      return resultSchema.parse(data);
    },
    (result) => ({ count: result.count })
  );
}
