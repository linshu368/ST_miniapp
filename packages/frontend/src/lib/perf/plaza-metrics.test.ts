import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportPlazaMetric } from './plaza-metrics';
const outputs = vi.hoisted(() => ({
  measurement: vi.fn(),
  event: vi.fn(),
  distribution: vi.fn(),
  count: vi.fn(),
}));
vi.mock('./env-tags', () => ({
  getMetricDimensions: () => ({ tg_platform: 'ios', net_type: '4g' }),
  getNetworkTags: () => ({ net_type: '4g', net_rtt_bucket: 'lt100' }),
}));
vi.mock('./grafana', () => ({
  recordEngineeringMeasurement: outputs.measurement,
  recordEngineeringEvent: outputs.event,
}));
vi.mock('./page-tracker', () => ({ markPageCriticalVisual: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution: outputs.distribution, count: outputs.count },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe('plaza same-source metrics', () => {
  it('retains actually observed stalls on background without adding background duration to P95', () => {
    vi.stubGlobal('document', { hidden: true });
    reportPlazaMetric('rebuffer', 'succeeded', 600, { route: '/create/work/:id' }, 3);
    expect(outputs.distribution).not.toHaveBeenCalled();
    expect(outputs.count).toHaveBeenCalledWith(
      'plaza.rebuffer.count',
      3,
      expect.objectContaining({
        attributes: expect.objectContaining({ outcome: 'background' }),
      })
    );
    expect(outputs.event).toHaveBeenCalledWith(
      'plaza.rebuffer',
      expect.objectContaining({ stall_count: 3 })
    );
  });
  it('does not invent a stall count for a playback failure', () => {
    reportPlazaMetric('rebuffer', 'failed', 600, { route: '/create/work/:id' });
    expect(outputs.count.mock.calls.some(([name]) => name === 'plaza.rebuffer.count')).toBe(false);
  });
  it('mirrors the exact duration and dimensions to both exporters', () => {
    reportPlazaMetric('first_frame', 'succeeded', 1234, {
      route: '/create/work/:id',
      media: 'video',
      measurement: 'video_frame_callback',
    });
    const dimensions = outputs.measurement.mock.calls[0]![2];
    expect(outputs.measurement).toHaveBeenCalledWith('plaza.first_frame', 1234, dimensions);
    expect(outputs.distribution).toHaveBeenCalledWith('plaza.first_frame.duration', 1234, {
      unit: 'millisecond',
      attributes: dimensions,
    });
    expect(dimensions).toMatchObject({
      tg_platform: 'ios',
      net_rtt_bucket: 'lt100',
      source_measurement_version: 'plaza_v1',
    });
  });
  it('counts failures without adding zero or error durations to successful P95', () => {
    reportPlazaMetric('seek', 'timeout', 10000, { route: '/create/work/:id' });
    expect(outputs.measurement).not.toHaveBeenCalled();
    expect(outputs.distribution).not.toHaveBeenCalled();
    expect(outputs.event).toHaveBeenCalledWith(
      'plaza.video_terminal',
      expect.objectContaining({ outcome: 'timeout' })
    );
    expect(outputs.count).toHaveBeenCalled();
  });
  it('keeps the other exporter working if one throws', () => {
    outputs.measurement.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    expect(() =>
      reportPlazaMetric('feed', 'succeeded', 400, {
        route: '/create',
        media: 'all',
        sort: 'recommended',
      })
    ).not.toThrow();
    expect(outputs.distribution).toHaveBeenCalled();
  });
});
