'use client';

import {
  DRAMA_TIMING_BODY_LIMIT,
  DRAMA_TIMING_UPLOAD_TIMEOUT_MS,
  DramaTimingReportSchema,
  PostDramaTimingDataSchema,
  type DramaTimingReport,
  type PostDramaTimingData,
} from '@miniapp/shared';

import { apiClient } from './client';

/** 单次、低优先级上报；总预算包括排队和响应体，不能拖住播放或无限积压。 */
export async function uploadDramaTiming(report: DramaTimingReport): Promise<void> {
  const body = JSON.stringify(DramaTimingReportSchema.parse(report));
  if (new TextEncoder().encode(body).byteLength > DRAMA_TIMING_BODY_LIMIT) {
    throw new Error('drama_timing_report_too_large');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAMA_TIMING_UPLOAD_TIMEOUT_MS);
  try {
    const data = await apiClient<PostDramaTimingData>('/api/telemetry/drama-timing', {
      method: 'POST',
      body,
      signal: controller.signal,
      timeoutMs: DRAMA_TIMING_UPLOAD_TIMEOUT_MS,
      queuePriority: 'background',
      keepalive: true,
    });
    PostDramaTimingDataSchema.parse(data);
  } finally {
    clearTimeout(timer);
  }
}
