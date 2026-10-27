import { describe, expect, it } from 'vitest';
import { readVideoProbe } from './video-media.js';

describe('readVideoProbe', () => {
  it('maps ffprobe metadata into positive integer dimensions and milliseconds', () => {
    expect(
      readVideoProbe({ streams: [{ width: 1920, height: 1080 }], format: { duration: '5.125' } })
    ).toEqual({ width: 1920, height: 1080, durationMs: 5125 });
  });

  it('rejects malformed metadata before publish', () => {
    expect(() => readVideoProbe({ streams: [], format: { duration: 1 } })).toThrow(
      'video_probe_invalid'
    );
    expect(() =>
      readVideoProbe({ streams: [{ width: 0, height: 1080 }], format: { duration: 1 } })
    ).toThrow('video_probe_invalid');
  });
});
