import type { DramaTimingReport } from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';

export class DramaTimingBusyError extends Error {}

/** This budget only governs telemetry; no play route waits on these writes. */
export class DramaTimingRepository {
  private active = 0;

  async persist(
    report: DramaTimingReport,
    context: { environment: string; release: string },
    importedAt?: string
  ): Promise<'stored' | 'duplicate' | 'conflict'> {
    if (this.active >= 2) throw new DramaTimingBusyError('drama_timing_busy');
    this.active += 1;
    try {
      const { data, error } = await getDomainDb('miniapp_analytics')
        .rpc('record_drama_playback_observation', {
          p_environment: context.environment,
          p_report: report,
          p_server_release: context.release,
          p_received_at: importedAt,
          p_source: importedAt ? 'railway_import' : 'live',
        })
        .abortSignal(AbortSignal.timeout(2_000));
      if (error) throw new Error('drama_timing_persist_failed', { cause: error });
      if (data !== 'stored' && data !== 'duplicate' && data !== 'conflict')
        throw new Error('drama_timing_persist_invalid_ack');
      return data;
    } finally {
      this.active -= 1;
    }
  }
}
