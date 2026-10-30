import { createHmac } from 'node:crypto';
import type { DramaDelivery } from '@miniapp/shared';
import {
  getDramaExperimentConfig,
  getDramaPlaybackCdnConfig,
} from '../../platform/runtime-config.js';

type Experiment = NonNullable<ReturnType<typeof getDramaExperimentConfig>>;

/** Separate HMAC domains prevent the public bucket from revealing the deduplication key. */
export function dramaExperimentUser(userId: number, experiment: Experiment) {
  const input = `${experiment.environment}:${experiment.id}:${userId}`;
  const bucket =
    createHmac('sha256', experiment.key).update(`bucket:${input}`).digest().readUInt32BE(0) % 10000;
  return {
    experiment_id: experiment.id,
    assigned_group: bucket < 2000 ? ('bunny' as const) : ('supabase' as const),
    experiment_user: createHmac('sha256', experiment.key).update(`user:${input}`).digest('hex'),
  };
}

export function selectDramaDelivery(userId: number) {
  const experiment = getDramaExperimentConfig();
  // Preserve the previously accepted TEST Preview while no experiment is configured.
  if (!experiment) return { cdn: getDramaPlaybackCdnConfig(), delivery: undefined };
  const group = dramaExperimentUser(userId, experiment).assigned_group;
  const cdn = group === 'bunny' && experiment.enabled ? getDramaPlaybackCdnConfig() : null;
  const delivery: DramaDelivery = {
    experimentId: experiment.id,
    group,
    provider: cdn ? 'bunny' : 'supabase',
    reason: experiment.enabled && (group === 'supabase' || cdn) ? 'assigned' : 'disabled',
  };
  return { cdn, delivery };
}

/** Identity is derived after authentication and never accepted from a browser report. */
export function dramaExperimentLogUser(userId: number) {
  try {
    const experiment = getDramaExperimentConfig();
    return experiment ? dramaExperimentUser(userId, experiment) : {};
  } catch {
    return { experiment_identity: 'unavailable' as const };
  }
}
