import '../instrumentation.js';
import { config } from '../platform/config.js';
import { getDomainDb, closeSupabaseClient } from '../lib/supabase.js';
import { rebuildImagePlazaFeedOrder } from '../features/image-plaza/feed-ranking.js';
import { runObservedJob, finishBackgroundOperation } from '../platform/observability/jobs.js';

const args = process.argv.slice(2);
try {
  await runObservedJob('image-plaza-feed-rebuild', async () => {
    const targetIndex = args.indexOf('--target');
    const target = args[targetIndex + 1];
    if (
      targetIndex < 0 ||
      !['test', 'production'].includes(target ?? '') ||
      target !== config.database.target
    )
      throw new Error('image_plaza_feed_target_mismatch');
    const allowed = new Set(['--target', target!, '--apply', '--confirm-production']);
    if (args.some((arg) => !allowed.has(arg))) throw new Error('image_plaza_feed_argument_invalid');
    if (!args.includes('--apply')) {
      const { count, error } = await getDomainDb('media_plaza')
        .from('image_plaza_works')
        .select('id', { count: 'exact', head: true })
        .is('deleted_at', null)
        .abortSignal(AbortSignal.timeout(10_000));
      if (error) throw new Error('image_plaza_feed_preview_failed', { cause: error });
      process.stdout.write(
        JSON.stringify({ target, mode: 'preview', count, capacity: 100000 }) + '\n'
      );
      finishBackgroundOperation('image-plaza-feed-rebuild', {
        outcome: 'succeeded',
        outcome_known: true,
      });
      return;
    }
    if (target === 'production' && !args.includes('--confirm-production'))
      throw new Error('image_plaza_feed_production_confirmation_required');
    const result = await rebuildImagePlazaFeedOrder();
    process.stdout.write(JSON.stringify({ target, mode: 'applied', ...result }) + '\n');
    finishBackgroundOperation('image-plaza-feed-rebuild', {
      outcome: 'succeeded',
      outcome_known: true,
    });
  });
} catch {
  // The observed operation owns the safe original error; CLI output is a fixed code only.
  process.stderr.write('image_plaza_feed_maintenance_failed\n');
  process.exitCode = 1;
} finally {
  await closeSupabaseClient();
}
