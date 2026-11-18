import '../platform/config.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  closeVideoSeedImportResources,
  downloadSeedVideoToFile,
  selectVideoSeedCanaryRows,
  type VideoSeedSourceRow,
} from '../features/image-plaza/video-seed-import.js';
import { prepareVideoFile, type PreparedVideoFile } from '../features/image-plaza/video-media.js';
import { loadReviewedVideoSeedPlan } from '../features/image-plaza/video-seed-plan.js';

interface ProcessedManifestRow extends VideoSeedSourceRow {
  selectionIndex: number;
  sourceBytes: number;
  sourceSha256: string;
  videoPath: string;
  posterPath: string;
  videoStoragePath: string;
  posterStoragePath: string;
  media: Omit<PreparedVideoFile, 'videoPath' | 'posterPath'>;
}

interface FailedManifestRow {
  selectionIndex: number;
  sourceVideoId: string;
  code: string;
}

interface ProcessManifest {
  version: 1;
  target: 'test';
  phase: 'processing' | 'processed_with_failures' | 'processed';
  createdAt: string;
  updatedAt: string;
  inputSha256: string;
  translationsSha256: string;
  selectionReportSha256: string;
  requestedRows: number;
  concurrency: number;
  ffmpegConcurrency: number;
  rows: ProcessedManifestRow[];
  failures: FailedManifestRow[];
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  assertTlsVerificationEnabled();
  const plan = await loadReviewedVideoSeedPlan({
    workbookPath: options.input,
    translationsPath: options.translations,
    reportPath: options.report,
    expectedReportSha256: options.reportHash,
  });
  const selection = selectVideoSeedCanaryRows(
    {
      rows: plan.rows,
      groups: [...new Map(plan.rows.map((row) => [row.modelId, row])).values()].map((row) => ({
        modelId: row.modelId,
        modelName: row.sourceModelName,
        candidateCount: 0,
        quota: 0,
        cutoffHeat: 0,
        cutoffTieCount: 0,
      })),
    },
    options.canary
  );
  await mkdir(options.output, { recursive: true });
  const manifestPath = join(options.output, 'processed-manifest.json');
  const manifest = await loadOrCreateManifest(manifestPath, {
    inputSha256: plan.inputSha256,
    translationsSha256: plan.translationsSha256,
    reportSha256: plan.reportSha256,
    requestedRows: selection.length,
    concurrency: options.concurrency,
    ffmpegConcurrency: options.ffmpegConcurrency,
  });
  await validateCompletedRows(manifest, selection, options.output);
  const completed = new Map(manifest.rows.map((row) => [row.sourceVideoId, row] as const));
  const failed = new Map(manifest.failures.map((row) => [row.sourceVideoId, row] as const));
  const ffmpegSlots = new Semaphore(options.ffmpegConcurrency);
  let cursor = 0;
  let saveQueue = Promise.resolve();
  const save = (): Promise<void> => {
    saveQueue = saveQueue.then(() => saveManifest(manifestPath, manifest));
    return saveQueue;
  };

  const worker = async (): Promise<void> => {
    while (cursor < selection.length) {
      const selectionIndex = cursor;
      cursor += 1;
      const row = selection[selectionIndex];
      if (!row || completed.has(row.sourceVideoId)) continue;
      const safeId = safePathSegment(row.sourceVideoId);
      const rowDirectory = join(options.output, 'assets', `${selectionIndex + 1}-${safeId}`);
      const sourcePath = join(rowDirectory, 'source.mp4');
      const preparedDirectory = join(rowDirectory, 'prepared');
      try {
        // Only a failed row's own staging directory is replaced during a resume.
        await rm(rowDirectory, { recursive: true, force: true });
        await mkdir(rowDirectory, { recursive: true });
        const source = await downloadSeedVideoToFile(row.videoUrl, sourcePath);
        const prepared = await ffmpegSlots.run(() =>
          prepareVideoFile(sourcePath, preparedDirectory)
        );
        await rm(sourcePath, { force: true });
        const result: ProcessedManifestRow = {
          ...row,
          selectionIndex,
          sourceBytes: source.bytes,
          sourceSha256: source.sha256,
          videoPath: prepared.videoPath,
          posterPath: prepared.posterPath,
          videoStoragePath: `media-plaza-video/imports/civitai/${safeId}/${prepared.videoSha256}/video.mp4`,
          posterStoragePath: `media-plaza-video/imports/civitai/${safeId}/${prepared.posterSha256}/poster.jpg`,
          media: omitLocalPaths(prepared),
        };
        completed.set(row.sourceVideoId, result);
        failed.delete(row.sourceVideoId);
        manifest.rows = [...completed.values()].sort(
          (left, right) => left.selectionIndex - right.selectionIndex
        );
        manifest.failures = [...failed.values()].sort(
          (left, right) => left.selectionIndex - right.selectionIndex
        );
        manifest.updatedAt = new Date().toISOString();
        await save();
        console.log(
          `video seed processed index=${selectionIndex + 1}/${selection.length} id=${row.sourceVideoId} model=${row.modelId} branch=${prepared.branch} source_bytes=${source.bytes} output_bytes=${prepared.videoBytes}`
        );
      } catch (err) {
        const code = err instanceof Error ? err.message : 'unknown';
        failed.set(row.sourceVideoId, { selectionIndex, sourceVideoId: row.sourceVideoId, code });
        manifest.failures = [...failed.values()].sort(
          (left, right) => left.selectionIndex - right.selectionIndex
        );
        manifest.updatedAt = new Date().toISOString();
        await save();
        console.error(
          `video seed process failed index=${selectionIndex + 1}/${selection.length} id=${row.sourceVideoId} code=${code}`
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, selection.length) }, () => worker())
  );
  await saveQueue;
  manifest.phase =
    manifest.rows.length === selection.length ? 'processed' : 'processed_with_failures';
  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifestPath, manifest);
  const manifestSha256 = createHash('sha256')
    .update(await readFile(manifestPath))
    .digest('hex');
  console.log(
    `video seed process complete phase=${manifest.phase} processed=${manifest.rows.length} failed=${manifest.failures.length} manifest=${manifestPath} manifest_sha256=${manifestSha256}`
  );
  if (manifest.phase !== 'processed') exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : 'video_seed_asset_processing_failed');
  exitCode = 1;
} finally {
  await closeVideoSeedImportResources().catch(() => {
    exitCode = 1;
  });
}
process.exitCode = exitCode;

function omitLocalPaths(
  prepared: PreparedVideoFile
): Omit<PreparedVideoFile, 'videoPath' | 'posterPath'> {
  const { videoPath: _videoPath, posterPath: _posterPath, ...metadata } = prepared;
  return metadata;
}

async function loadOrCreateManifest(
  path: string,
  expected: {
    inputSha256: string;
    translationsSha256: string;
    reportSha256: string;
    requestedRows: number;
    concurrency: number;
    ffmpegConcurrency: number;
  }
): Promise<ProcessManifest> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('video_seed_manifest_invalid');
    const manifest = value as ProcessManifest;
    if (
      manifest.version !== 1 ||
      manifest.target !== 'test' ||
      manifest.inputSha256 !== expected.inputSha256 ||
      manifest.translationsSha256 !== expected.translationsSha256 ||
      manifest.selectionReportSha256 !== expected.reportSha256 ||
      manifest.requestedRows !== expected.requestedRows ||
      !Array.isArray(manifest.rows) ||
      !Array.isArray(manifest.failures)
    ) {
      throw new Error('video_seed_manifest_mismatch');
    }
    manifest.phase = 'processing';
    manifest.concurrency = expected.concurrency;
    manifest.ffmpegConcurrency = expected.ffmpegConcurrency;
    return manifest;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      const now = new Date().toISOString();
      return {
        version: 1,
        target: 'test',
        phase: 'processing',
        createdAt: now,
        updatedAt: now,
        inputSha256: expected.inputSha256,
        translationsSha256: expected.translationsSha256,
        selectionReportSha256: expected.reportSha256,
        requestedRows: expected.requestedRows,
        concurrency: expected.concurrency,
        ffmpegConcurrency: expected.ffmpegConcurrency,
        rows: [],
        failures: [],
      };
    }
    throw err;
  }
}

async function saveManifest(path: string, manifest: ProcessManifest): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function validateCompletedRows(
  manifest: ProcessManifest,
  selection: VideoSeedSourceRow[],
  outputRoot: string
): Promise<void> {
  const seen = new Set<string>();
  for (const row of manifest.rows) {
    const expected = selection[row.selectionIndex];
    if (
      !expected ||
      expected.sourceVideoId !== row.sourceVideoId ||
      seen.has(row.sourceVideoId) ||
      !isDescendant(outputRoot, row.videoPath) ||
      !isDescendant(outputRoot, row.posterPath) ||
      row.videoStoragePath !==
        `media-plaza-video/imports/civitai/${safePathSegment(row.sourceVideoId)}/${row.media.videoSha256}/video.mp4` ||
      row.posterStoragePath !==
        `media-plaza-video/imports/civitai/${safePathSegment(row.sourceVideoId)}/${row.media.posterSha256}/poster.jpg`
    ) {
      throw new Error('video_seed_manifest_completed_row_invalid');
    }
    seen.add(row.sourceVideoId);
    const [video, poster, videoHash, posterHash] = await Promise.all([
      stat(row.videoPath),
      stat(row.posterPath),
      sha256File(row.videoPath),
      sha256File(row.posterPath),
    ]);
    if (
      video.size !== row.media.videoBytes ||
      poster.size !== row.media.posterBytes ||
      videoHash !== row.media.videoSha256 ||
      posterHash !== row.media.posterSha256
    ) {
      throw new Error('video_seed_manifest_completed_asset_mismatch');
    }
  }
}

function isDescendant(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '' && !value.startsWith('..') && !isAbsolute(value);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function safePathSegment(value: string): string {
  const result = value
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (!result) throw new Error('video_seed_source_id_path_invalid');
  return result;
}

function assertTlsVerificationEnabled(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('video_seed_tls_verification_disabled');
  }
}

function parseArgs(args: string[]): {
  input: string;
  translations: string;
  report: string;
  reportHash: string;
  output: string;
  canary: number;
  concurrency: number;
  ffmpegConcurrency: number;
} {
  const result = {
    input: '',
    translations: '',
    report: '',
    reportHash: '',
    output: '',
    canary: 10,
    concurrency: 4,
    ffmpegConcurrency: 2,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => args[++index] ?? '';
    if (arg === '--input') result.input = value();
    else if (arg === '--translations') result.translations = value();
    else if (arg === '--report') result.report = value();
    else if (arg === '--confirm-size') result.reportHash = value();
    else if (arg === '--output') result.output = value();
    else if (arg === '--target') {
      if (value() !== 'test') throw new Error('video_seed_only_test_canary_is_enabled');
    } else if (arg === '--canary') result.canary = integer(value(), 10, 10, arg);
    else if (arg === '--concurrency') result.concurrency = integer(value(), 1, 4, arg);
    else if (arg === '--ffmpeg-concurrency') {
      result.ffmpegConcurrency = integer(value(), 1, 2, arg);
    } else if (arg === '--phase') {
      if (value() !== 'process') throw new Error('video_seed_only_process_phase_is_enabled');
    } else throw new Error(`unknown_argument:${arg ?? ''}`);
  }
  if (
    !result.input ||
    !result.translations ||
    !result.report ||
    !result.reportHash ||
    !result.output
  ) {
    throw new Error('video_seed_asset_arguments_required');
  }
  const path = (value: string) =>
    isAbsolute(value) ? value : resolve(process.env.INIT_CWD || process.cwd(), value);
  result.input = path(result.input);
  result.translations = path(result.translations);
  result.report = path(result.report);
  result.output = path(result.output);
  return result;
}

function integer(value: string, min: number, max: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid_integer:${name}`);
  }
  return parsed;
}
