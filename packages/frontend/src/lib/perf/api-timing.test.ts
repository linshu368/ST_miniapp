import { beforeEach, describe, expect, it, vi } from 'vitest';

const telemetry = vi.hoisted(() => ({
  enabled: true,
  measurement: vi.fn(),
  event: vi.fn(),
}));
vi.mock('./grafana', () => ({
  isEngineeringTelemetryEnabled: () => telemetry.enabled,
  recordEngineeringMeasurement: telemetry.measurement,
  recordEngineeringEvent: telemetry.event,
}));

import {
  apiRouteGroup,
  recordApiAttempt,
  recordApiTotal,
  shouldObserveApiTiming,
} from './api-timing';

describe('API engineering timing projection', () => {
  beforeEach(() => {
    telemetry.enabled = true;
    telemetry.measurement.mockClear();
    telemetry.event.mockClear();
  });

  it('exports finite groups, never IDs, query strings or arbitrary URLs', () => {
    expect(apiRouteGroup('/api/dramas/short-id/playback?token=secret')).toBe('drama_playback');
    expect(apiRouteGroup('/api/dramas/short-id/play?episode=2')).toBe('drama_playback');
    expect(apiRouteGroup('/api/v1/conversations/id/messages?secret=yes')).toBe('conversation_turn');
    expect(apiRouteGroup('/api/unknown/private-user')).toBe('other');
    expect(apiRouteGroup('https://private.example/api/dramas')).toBe('other');
  });

  it('does not observe diagnostic uploads or allocate when disabled', () => {
    expect(shouldObserveApiTiming('/api/telemetry/drama-timing')).toBe(false);
    expect(shouldObserveApiTiming('/api/dramas')).toBe(true);
    telemetry.enabled = false;
    expect(shouldObserveApiTiming('/api/dramas')).toBe(false);
  });

  it('measures queue, headers and body from the same attempt, without request identity', () => {
    recordApiAttempt(
      '/api/dramas/short-id?token=secret',
      'GET',
      {
        requestId: 'never-export-this',
        queuedAt: 100,
        dispatchedAt: 400,
        headersAt: 900,
        endedAt: 2000,
        status: 200,
        outcome: 'ok',
      },
      1
    );
    expect(telemetry.measurement.mock.calls.map(([name, duration]) => [name, duration])).toEqual([
      ['api.queue', 300],
      ['api.headers', 500],
      ['api.body', 1100],
    ]);
    expect(telemetry.measurement.mock.calls[0]?.[2]).toEqual({
      api_route: 'drama_detail',
      method: 'GET',
      status_class: '2xx',
      outcome: 'ok',
      attempt: 1,
      source_measurement_version: 'api_attempt_v1',
    });
    expect(JSON.stringify(telemetry.measurement.mock.calls)).not.toMatch(
      /short-id|secret|never-export/
    );
  });

  it('queued cancellation is terminal but never fabricated as server/header/body time', () => {
    const timing = { requestId: 'x', queuedAt: 100, endedAt: 500, outcome: 'aborted' as const };
    recordApiAttempt('/api/dramas', 'GET', timing, 1);
    expect(telemetry.measurement).not.toHaveBeenCalled();
    vi.spyOn(performance, 'now').mockReturnValue(500);
    recordApiTotal('/api/dramas', 'GET', 100, timing, 1);
    expect(telemetry.measurement).toHaveBeenCalledWith(
      'api.total',
      400,
      expect.objectContaining({
        outcome: 'aborted',
        attempts: 1,
        status_class: 'network',
      })
    );
    expect(telemetry.event).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
