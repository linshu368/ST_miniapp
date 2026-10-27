import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../platform/config.js';

let available = false;

export async function initializeVideoMedia(log: FastifyBaseLogger): Promise<void> {
  if (!config.imagePlaza.videoWorkerEnabled) {
    available = false;
    return;
  }
  try {
    await Promise.all([
      run(config.imagePlaza.ffmpegPath, ['-version'], 10_000),
      run(config.imagePlaza.ffprobePath, ['-version'], 10_000),
    ]);
    available = true;
  } catch (err) {
    available = false;
    log.error(
      { err, event: 'video_plaza.media_tools_unavailable' },
      'Video models disabled: ffmpeg/ffprobe unavailable'
    );
  }
}

export function isVideoMediaAvailable(): boolean {
  return available;
}

export async function prepareVideo(bytes: Buffer): Promise<{
  video: Buffer;
  poster: Buffer;
  width: number;
  height: number;
  durationMs: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'media-plaza-'));
  const input = join(directory, 'input.mp4');
  const output = join(directory, 'video.mp4');
  const poster = join(directory, 'poster.jpg');
  try {
    await writeFile(input, bytes);
    await run(
      config.imagePlaza.ffmpegPath,
      ['-v', 'error', '-i', input, '-c', 'copy', '-movflags', '+faststart', '-y', output],
      120_000
    );
    await run(
      config.imagePlaza.ffmpegPath,
      ['-v', 'error', '-i', output, '-frames:v', '1', '-q:v', '3', '-y', poster],
      120_000
    );
    const probe = await run(
      config.imagePlaza.ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration',
        '-of',
        'json',
        output,
      ],
      30_000
    );
    const metadata = readProbe(JSON.parse(probe) as unknown);
    return { video: await readFile(output), poster: await readFile(poster), ...metadata };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

export function readVideoProbe(value: unknown): {
  width: number;
  height: number;
  durationMs: number;
} {
  return readProbe(value);
}

function readProbe(value: unknown): { width: number; height: number; durationMs: number } {
  if (!value || typeof value !== 'object') throw new Error('video_probe_invalid');
  const object = value as { streams?: unknown; format?: unknown };
  const stream = Array.isArray(object.streams) ? object.streams[0] : null;
  const format = object.format;
  if (!stream || typeof stream !== 'object' || !format || typeof format !== 'object')
    throw new Error('video_probe_invalid');
  const width = Number((stream as { width?: unknown }).width);
  const height = Number((stream as { height?: unknown }).height);
  const durationMs = Math.round(Number((format as { duration?: unknown }).duration) * 1000);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(durationMs) ||
    width < 1 ||
    height < 1 ||
    durationMs < 1
  )
    throw new Error('video_probe_invalid');
  return { width, height, durationMs };
}
