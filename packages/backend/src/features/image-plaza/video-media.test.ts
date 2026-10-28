import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMp4Atoms, readVideoProbe } from './video-media.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('readVideoProbe', () => {
  it('maps ffprobe metadata into positive integer dimensions and milliseconds', () => {
    expect(
      readVideoProbe({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            pix_fmt: 'yuv420p',
            r_frame_rate: '30/1',
          },
        ],
        format: { duration: '5.125' },
      })
    ).toEqual({ width: 1920, height: 1080, durationMs: 5125 });
  });

  it('rejects malformed metadata before publish', () => {
    expect(() => readVideoProbe({ streams: [], format: { duration: 1 } })).toThrow(
      'video_probe_invalid'
    );
    expect(() =>
      readVideoProbe({
        streams: [
          {
            codec_type: 'video',
            width: 0,
            height: 1080,
            r_frame_rate: '30/1',
          },
        ],
        format: { duration: 1 },
      })
    ).toThrow('video_probe_invalid');
  });
});

describe('readMp4Atoms', () => {
  it('finds a bounded moov atom before media data without loading the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-atoms-test-'));
    directories.push(directory);
    const path = join(directory, 'video.mp4');
    await writeFile(path, Buffer.concat([atom('ftyp', 8), atom('moov', 32), atom('mdat', 64)]));

    await expect(readMp4Atoms(path)).resolves.toEqual({
      moovOffset: 16,
      moovBytes: 40,
      mdatOffset: 56,
    });
  });
});

function atom(type: string, payloadBytes: number): Buffer {
  const buffer = Buffer.alloc(8 + payloadBytes);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write(type, 4, 4, 'ascii');
  return buffer;
}
