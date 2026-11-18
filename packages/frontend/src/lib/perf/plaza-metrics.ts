'use client';
import * as Sentry from '@sentry/nextjs';
import { getMetricDimensions, getNetworkTags } from './env-tags';
import { recordEngineeringEvent, recordEngineeringMeasurement } from './grafana';
import { markPageCriticalVisual } from './page-tracker';

export type PlazaStage =
  | 'feed'
  | 'poster'
  | 'video_prepare'
  | 'first_frame'
  | 'entry_first_frame'
  | 'seek'
  | 'rebuffer';
export type PlazaOutcome =
  | 'succeeded'
  | 'loaded'
  | 'error'
  | 'absent'
  | 'timeout'
  | 'background'
  | 'left'
  | 'interrupted'
  | 'failed'
  | 'paused'
  | 'cancelled';
export type PlazaDimensions = {
  route: '/create' | '/create/work/:id' | '/create/studio/:id';
  media?: 'all' | 'image' | 'video';
  sort?: 'recommended' | 'latest';
  cache?: 'fetch' | 'inflight' | 'cache' | 'unknown';
  page_kind?: 'first_page' | 'next_page';
  entry_kind?: 'initial' | 'continuation';
  measurement?:
    | 'video_frame_callback'
    | 'playing_and_timeupdate'
    | 'image_decode_after_frame'
    | 'response_parsed'
    | 'media_ready';
};

/** One result, two best-effort exporters; telemetry never controls playback or pagination. */
export function reportPlazaMetric(
  stage: PlazaStage,
  outcome: PlazaOutcome,
  durationMs: number,
  dimensions: PlazaDimensions,
  stallCount?: number
) {
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (hidden && (outcome === 'loaded' || outcome === 'succeeded')) outcome = 'background';
  const attributes = {
    ...getMetricDimensions(),
    ...getNetworkTags(),
    ...dimensions,
    stage,
    outcome,
    visibility: hidden || outcome === 'background' ? 'background' : 'foreground',
    source_measurement_version: 'plaza_v1',
  };
  const success = outcome === 'succeeded' || outcome === 'loaded';
  const validDuration = Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 3_600_000;
  const observedStalls =
    typeof stallCount === 'number' && Number.isFinite(stallCount)
      ? Math.min(10000, Math.max(0, Math.trunc(stallCount)))
      : undefined;
  const event =
    stage === 'feed' || stage === 'poster'
      ? 'plaza.feed_terminal'
      : stage === 'rebuffer'
        ? 'plaza.rebuffer'
        : 'plaza.video_terminal';
  try {
    if (stage === 'first_frame' && success && dimensions.route === '/create/work/:id')
      markPageCriticalVisual(dimensions.route, 'loaded');
    if (success && validDuration)
      recordEngineeringMeasurement(`plaza.${stage}`, durationMs, attributes);
    recordEngineeringEvent(
      event,
      stage === 'rebuffer' && observedStalls !== undefined
        ? { ...attributes, stall_count: observedStalls }
        : attributes
    );
  } catch {
    /* Exporter failures do not change the observed business result. */
  }
  try {
    if (success && validDuration)
      Sentry.metrics.distribution(`plaza.${stage}.duration`, durationMs, {
        unit: 'millisecond',
        attributes,
      });
    Sentry.metrics.count(
      stage === 'feed' || stage === 'poster' ? `plaza.${stage}.outcome` : 'plaza.video.outcome',
      1,
      { attributes }
    );
    if (stage === 'rebuffer' && observedStalls !== undefined)
      Sentry.metrics.count('plaza.rebuffer.count', observedStalls, {
        attributes,
      });
  } catch {
    /* Sentry may be unavailable independently of Faro. */
  }
}
