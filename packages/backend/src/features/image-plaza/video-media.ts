import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../platform/config.js';

const MAX_FASTSTART_MOOV_BYTES = 256 * 1024;
const MAX_KEYFRAME_INTERVAL_SECONDS = 2.1;
const FIRST_KEYFRAME_MAX_SECONDS = 0.1;
const MEDIA_COMMAND_TIMEOUT_MS = 30 * 60_000;

let available = false;

export type VideoProcessingBranch = 'direct' | 'remux' | 'transcode';

export interface PreparedVideoFile {
  videoPath: string;
  posterPath: string;
  videoSha256: string;
  posterSha256: string;
  videoBytes: number;
  posterBytes: number;
  width: number;
  height: number;
  posterWidth: number;
  posterHeight: number;
  durationMs: number;
  branch: VideoProcessingBranch;
  codec: string;
  audioCodec: string | null;
  pixelFormat: string;
  framesPerSecond: number;
  firstKeyframeSeconds: number;
  maxKeyframeIntervalSeconds: number;
  moovOffset: number;
  moovBytes: number;
  mdatOffset: number;
}

interface ProbeMetadata {
  width: number;
  height: number;
  durationMs: number;
  codec: string;
  audioCodec: string | null;
  pixelFormat: string;
  colorTransfer: string | null;
  framesPerSecond: number;
}

interface KeyframeMetadata {
  firstSeconds: number;
  lastSeconds: number;
  maxIntervalSeconds: number;
  count: number;
}

interface Mp4Atoms {
  moovOffset: number;
  moovBytes: number;
  mdatOffset: number;
}

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

/**
 * File-backed pipeline used by seed imports. The source and result remain on disk so four lanes do
 * not multiply memory usage by the size of each video.
 */
export async function prepareVideoFile(
  inputPath: string,
  outputDirectory: string
): Promise<PreparedVideoFile> {
  await mkdir(outputDirectory, { recursive: true });
  const videoPath = join(outputDirectory, 'video.mp4');
  const posterPath = join(outputDirectory, 'poster.jpg');
  const inputProbe = await probeVideo(inputPath);
  if (inputProbe.colorTransfer === 'smpte2084' || inputProbe.colorTransfer === 'arib-std-b67') {
    throw new Error('video_hdr_manual_review_required');
  }
  const inputAtoms = await readMp4Atoms(inputPath).catch(() => null);
  const inputKeyframes = await probeKeyframes(inputPath, inputProbe.durationMs);
  const compatible =
    inputProbe.codec === 'h264' &&
    inputProbe.pixelFormat === 'yuv420p' &&
    (inputProbe.audioCodec === null || inputProbe.audioCodec === 'aac') &&
    inputProbe.framesPerSecond <= 30.01;
  const seekable = keyframesMeetGate(inputKeyframes);
  const faststart = atomsMeetGate(inputAtoms);
  let branch: VideoProcessingBranch;
  if (compatible && seekable && faststart) {
    branch = 'direct';
    await copyFile(inputPath, videoPath);
  } else if (compatible && seekable) {
    branch = 'remux';
    await run(
      config.imagePlaza.ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        videoPath,
      ],
      MEDIA_COMMAND_TIMEOUT_MS
    );
  } else {
    branch = 'transcode';
    await run(
      config.imagePlaza.ffmpegPath,
      [
        '-v',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-fpsmax',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-maxrate',
        '6M',
        '-bufsize',
        '12M',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'high',
        '-level:v',
        '4.1',
        '-force_key_frames',
        'expr:gte(t,n_forced*2)',
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        videoPath,
      ],
      MEDIA_COMMAND_TIMEOUT_MS
    );
  }

  await run(
    config.imagePlaza.ffmpegPath,
    [
      '-v',
      'error',
      '-ss',
      '0',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-q:v',
      '3',
      '-y',
      posterPath,
    ],
    120_000
  );

  const outputProbe = await probeVideo(videoPath);
  const [outputKeyframes, outputAtoms, posterProbe] = await Promise.all([
    probeKeyframes(videoPath, outputProbe.durationMs),
    readMp4Atoms(videoPath),
    probeImage(posterPath),
  ]);
  if (
    outputProbe.codec !== 'h264' ||
    outputProbe.pixelFormat !== 'yuv420p' ||
    (outputProbe.audioCodec !== null && outputProbe.audioCodec !== 'aac') ||
    !keyframesMeetGate(outputKeyframes) ||
    !atomsMeetGate(outputAtoms)
  ) {
    throw new Error('video_output_playback_gate_failed');
  }
  await validateDecodePositions(videoPath, outputProbe.durationMs);
  const [videoInfo, posterInfo, videoSha256, posterSha256] = await Promise.all([
    stat(videoPath),
    stat(posterPath),
    sha256File(videoPath),
    sha256File(posterPath),
  ]);
  return {
    videoPath,
    posterPath,
    videoSha256,
    posterSha256,
    videoBytes: videoInfo.size,
    posterBytes: posterInfo.size,
    width: outputProbe.width,
    height: outputProbe.height,
    posterWidth: posterProbe.width,
    posterHeight: posterProbe.height,
    durationMs: outputProbe.durationMs,
    branch,
    codec: outputProbe.codec,
    audioCodec: outputProbe.audioCodec,
    pixelFormat: outputProbe.pixelFormat,
    framesPerSecond: outputProbe.framesPerSecond,
    firstKeyframeSeconds: outputKeyframes.firstSeconds,
    maxKeyframeIntervalSeconds: outputKeyframes.maxIntervalSeconds,
    ...outputAtoms,
  };
}

/** Runtime worker compatibility wrapper. Seed imports must use prepareVideoFile directly. */
export async function prepareVideo(bytes: Buffer): Promise<{
  video: Buffer;
  poster: Buffer;
  width: number;
  height: number;
  durationMs: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'media-plaza-'));
  const input = join(directory, 'input.mp4');
  try {
    await writeFile(input, bytes);
    const prepared = await prepareVideoFile(input, join(directory, 'prepared'));
    return {
      video: await readFile(prepared.videoPath),
      poster: await readFile(prepared.posterPath),
      width: prepared.width,
      height: prepared.height,
      durationMs: prepared.durationMs,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probeVideo(path: string): Promise<ProbeMetadata> {
  const output = await run(
    config.imagePlaza.ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,color_transfer:format=duration',
      '-of',
      'json',
      path,
    ],
    30_000
  );
  return readDetailedProbe(JSON.parse(output) as unknown);
}

async function probeImage(path: string): Promise<{ width: number; height: number }> {
  const output = await run(
    config.imagePlaza.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      path,
    ],
    30_000
  );
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object') throw new Error('video_poster_probe_invalid');
  const streams = (value as { streams?: unknown }).streams;
  const stream = Array.isArray(streams) ? streams[0] : null;
  if (!stream || typeof stream !== 'object') throw new Error('video_poster_probe_invalid');
  const width = Number((stream as { width?: unknown }).width);
  const height = Number((stream as { height?: unknown }).height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('video_poster_probe_invalid');
  }
  return { width, height };
}

async function probeKeyframes(path: string, durationMs: number): Promise<KeyframeMetadata> {
  const output = await run(
    config.imagePlaza.ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'json',
      path,
    ],
    120_000,
    8 * 1024 * 1024
  );
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object') throw new Error('video_keyframe_probe_invalid');
  const frames = (value as { frames?: unknown }).frames;
  if (!Array.isArray(frames) || frames.length < 1) throw new Error('video_keyframe_probe_invalid');
  const times = frames.map((frame) => {
    if (!frame || typeof frame !== 'object') throw new Error('video_keyframe_probe_invalid');
    const seconds = Number(
      (frame as { best_effort_timestamp_time?: unknown }).best_effort_timestamp_time
    );
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('video_keyframe_probe_invalid');
    return seconds;
  });
  let maxIntervalSeconds = 0;
  for (let index = 1; index < times.length; index += 1) {
    maxIntervalSeconds = Math.max(maxIntervalSeconds, times[index]! - times[index - 1]!);
  }
  maxIntervalSeconds = Math.max(maxIntervalSeconds, durationMs / 1000 - times[times.length - 1]!);
  return {
    firstSeconds: times[0]!,
    lastSeconds: times[times.length - 1]!,
    maxIntervalSeconds,
    count: times.length,
  };
}

function keyframesMeetGate(value: KeyframeMetadata): boolean {
  return (
    value.count > 0 &&
    value.firstSeconds <= FIRST_KEYFRAME_MAX_SECONDS &&
    value.maxIntervalSeconds <= MAX_KEYFRAME_INTERVAL_SECONDS
  );
}

function atomsMeetGate(value: Mp4Atoms | null): value is Mp4Atoms {
  return Boolean(
    value &&
    value.moovOffset >= 0 &&
    value.mdatOffset >= 0 &&
    value.moovOffset < value.mdatOffset &&
    value.moovBytes <= MAX_FASTSTART_MOOV_BYTES
  );
}

export async function readMp4Atoms(path: string): Promise<Mp4Atoms> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    let offset = 0;
    let moovOffset = -1;
    let moovBytes = -1;
    let mdatOffset = -1;
    const header = Buffer.alloc(16);
    while (offset + 8 <= size) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      const size32 = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let atomBytes = size32;
      if (size32 === 1) {
        if (bytesRead < 16) throw new Error('video_mp4_atom_invalid');
        const size64 = header.readBigUInt64BE(8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('video_mp4_atom_invalid');
        atomBytes = Number(size64);
      } else if (size32 === 0) {
        atomBytes = size - offset;
      }
      if (atomBytes < 8 || offset + atomBytes > size) throw new Error('video_mp4_atom_invalid');
      if (type === 'moov') {
        moovOffset = offset;
        moovBytes = atomBytes;
      } else if (type === 'mdat' && mdatOffset < 0) {
        mdatOffset = offset;
      }
      offset += atomBytes;
    }
    if (moovOffset < 0 || moovBytes < 0 || mdatOffset < 0)
      throw new Error('video_mp4_atom_missing');
    return { moovOffset, moovBytes, mdatOffset };
  } finally {
    await handle.close();
  }
}

async function validateDecodePositions(path: string, durationMs: number): Promise<void> {
  const durationSeconds = durationMs / 1000;
  for (const fraction of [0, 0.1, 0.5, 0.9]) {
    const position = Math.max(0, Math.min(durationSeconds - 0.05, durationSeconds * fraction));
    await run(
      config.imagePlaza.ffmpegPath,
      ['-v', 'error', '-ss', position.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'null', '-'],
      30_000
    );
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function run(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer = 1024 * 1024
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });
}

export function readVideoProbe(value: unknown): {
  width: number;
  height: number;
  durationMs: number;
} {
  const metadata = readDetailedProbe(value);
  return { width: metadata.width, height: metadata.height, durationMs: metadata.durationMs };
}

function readDetailedProbe(value: unknown): ProbeMetadata {
  if (!value || typeof value !== 'object') throw new Error('video_probe_invalid');
  const object = value as { streams?: unknown; format?: unknown };
  const streams = Array.isArray(object.streams) ? object.streams : [];
  const video = streams.find(
    (stream) =>
      stream &&
      typeof stream === 'object' &&
      (stream as { codec_type?: unknown }).codec_type === 'video'
  );
  const audio = streams.find(
    (stream) =>
      stream &&
      typeof stream === 'object' &&
      (stream as { codec_type?: unknown }).codec_type === 'audio'
  );
  const fallbackVideo = video ?? streams[0];
  const format = object.format;
  if (
    !fallbackVideo ||
    typeof fallbackVideo !== 'object' ||
    !format ||
    typeof format !== 'object'
  ) {
    throw new Error('video_probe_invalid');
  }
  const typedVideo = fallbackVideo as Record<string, unknown>;
  const width = Number(typedVideo.width);
  const height = Number(typedVideo.height);
  const durationMs = Math.round(Number((format as { duration?: unknown }).duration) * 1000);
  const framesPerSecond = parseFrameRate(typedVideo.r_frame_rate ?? '0/1');
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(durationMs) ||
    width < 1 ||
    height < 1 ||
    durationMs < 1 ||
    !Number.isFinite(framesPerSecond) ||
    framesPerSecond <= 0
  ) {
    throw new Error('video_probe_invalid');
  }
  return {
    width,
    height,
    durationMs,
    codec: typeof typedVideo.codec_name === 'string' ? typedVideo.codec_name : '',
    audioCodec:
      audio &&
      typeof audio === 'object' &&
      typeof (audio as { codec_name?: unknown }).codec_name === 'string'
        ? ((audio as { codec_name: string }).codec_name ?? null)
        : null,
    pixelFormat: typeof typedVideo.pix_fmt === 'string' ? typedVideo.pix_fmt : '',
    colorTransfer: typeof typedVideo.color_transfer === 'string' ? typedVideo.color_transfer : null,
    framesPerSecond,
  };
}

function parseFrameRate(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator! / denominator!;
}
