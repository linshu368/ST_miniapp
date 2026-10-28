import '../platform/config.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { DefaultHttpStack, Upload } from 'tus-js-client';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../platform/config.js';

const BUCKET = 'media-plaza-video';
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
let storageDispatcher: ProxyAgent | undefined;
let tusProxyAgent: HttpsProxyAgent<string> | undefined;

interface ProcessedRow {
  selectionIndex: number;
  sourceVideoId: string;
  videoPath: string;
  posterPath: string;
  videoStoragePath: string;
  posterStoragePath: string;
  media: { videoBytes: number; posterBytes: number };
}

interface ProcessedManifest {
  version: number;
  target: string;
  phase: string;
  requestedRows: number;
  rows: ProcessedRow[];
  failures: unknown[];
}

interface UploadStateEntry {
  uploadUrl?: string;
  verified: boolean;
  bytes: number;
}

interface UploadState {
  version: 1;
  target: 'test';
  projectRef: string;
  processedManifestSha256: string;
  updatedAt: string;
  objects: Record<string, UploadStateEntry>;
}

interface UploadAsset {
  localPath: string;
  storagePath: string;
  contentType: 'video/mp4' | 'image/jpeg';
  expectedBytes: number;
}

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  assertEnvironment(options.confirmProjectRef);
  const manifestBytes = await readFile(options.manifest);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const manifest = parseProcessedManifest(
    manifestBytes.toString('utf8'),
    dirname(options.manifest)
  );
  const statePath = join(dirname(options.manifest), 'upload-state.json');
  const state = await loadUploadState(statePath, manifestSha256, options.confirmProjectRef);
  await preflightBucket();
  console.log(
    `video seed upload preflight target=test project_ref=${options.confirmProjectRef} bucket=${BUCKET} objects=${manifest.rows.length * 2} apply=${options.apply}`
  );
  if (!options.apply) {
    console.log(
      'video seed upload dry-run complete; pass --apply only after reviewing this preflight'
    );
  } else {
    const assets = manifest.rows.flatMap<UploadAsset>((row) => [
      {
        localPath: row.videoPath,
        storagePath: row.videoStoragePath,
        contentType: 'video/mp4',
        expectedBytes: row.media.videoBytes,
      },
      {
        localPath: row.posterPath,
        storagePath: row.posterStoragePath,
        contentType: 'image/jpeg',
        expectedBytes: row.media.posterBytes,
      },
    ]);
    let cursor = 0;
    let saveQueue = Promise.resolve();
    const save = (): Promise<void> => {
      saveQueue = saveQueue.then(() => saveUploadState(statePath, state));
      return saveQueue;
    };
    const worker = async (): Promise<void> => {
      while (cursor < assets.length) {
        const asset = assets[cursor++];
        if (!asset) return;
        const file = await stat(asset.localPath);
        if (file.size !== asset.expectedBytes)
          throw new Error('video_seed_upload_local_size_mismatch');
        const existing = state.objects[asset.storagePath];
        if (existing?.verified) {
          if (!(await verifyObject(asset.storagePath, asset.expectedBytes))) {
            throw new Error('video_seed_verified_object_missing');
          }
          continue;
        }
        await uploadAsset(asset, existing?.uploadUrl, async (uploadUrl) => {
          state.objects[asset.storagePath] = {
            uploadUrl,
            verified: false,
            bytes: asset.expectedBytes,
          };
          state.updatedAt = new Date().toISOString();
          await save();
        });
        if (!(await verifyObject(asset.storagePath, asset.expectedBytes))) {
          throw new Error('video_seed_uploaded_object_missing');
        }
        state.objects[asset.storagePath] = { verified: true, bytes: asset.expectedBytes };
        state.updatedAt = new Date().toISOString();
        await save();
        console.log(
          `video seed uploaded object=${asset.storagePath} bytes=${asset.expectedBytes} verified=true`
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, assets.length) }, () => worker())
    );
    await saveQueue;
    const verified = assets.filter((asset) => state.objects[asset.storagePath]?.verified).length;
    console.log(
      `video seed upload complete target=test verified=${verified}/${assets.length} state=${statePath}`
    );
    if (verified !== assets.length) exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : 'video_seed_upload_failed');
  exitCode = 1;
} finally {
  await storageDispatcher?.destroy().catch(() => {
    exitCode = 1;
  });
  tusProxyAgent?.destroy();
}
process.exitCode = exitCode;

async function uploadAsset(
  asset: UploadAsset,
  uploadUrl: string | undefined,
  onUploadUrl: (value: string) => Promise<void>
): Promise<void> {
  await new Promise<void>((resolveUpload, rejectUpload) => {
    const upload = new Upload(
      createReadStream(asset.localPath) as unknown as Pick<ReadableStreamDefaultReader, 'read'>,
      {
        endpoint: resumableEndpoint(),
        httpStack: new DefaultHttpStack(
          getTusProxyAgent() ? { agent: getTusProxyAgent() } : undefined
        ),
        ...(uploadUrl ? { uploadUrl } : {}),
        uploadSize: asset.expectedBytes,
        chunkSize: TUS_CHUNK_BYTES,
        retryDelays: [0, 1_000, 3_000, 5_000],
        storeFingerprintForResuming: false,
        removeFingerprintOnSuccess: false,
        headers: authHeaders({ 'x-upsert': 'false' }),
        metadata: {
          bucketName: BUCKET,
          objectName: asset.storagePath,
          contentType: asset.contentType,
          cacheControl: '86400',
        },
        onUploadUrlAvailable: () => {
          if (!upload.url) return;
          void onUploadUrl(upload.url).catch(rejectUpload);
        },
        onError: rejectUpload,
        onSuccess: () => resolveUpload(),
      }
    );
    upload.start();
  });
}

async function preflightBucket(): Promise<void> {
  const response = await storageFetch(`${config.supabase.url}/storage/v1/bucket/${BUCKET}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`video_seed_bucket_preflight_${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || (value as { public?: unknown }).public !== false) {
    throw new Error('video_seed_bucket_must_be_private');
  }
}

async function verifyObject(path: string, expectedBytes: number): Promise<boolean> {
  const response = await storageFetch(
    `${config.supabase.url}/storage/v1/object/authenticated/${BUCKET}/${encodeObjectPath(path)}`,
    {
      headers: authHeaders({ Range: 'bytes=0-0' }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (response.status !== 206) throw new Error(`video_seed_object_verify_${response.status}`);
  await response.body?.cancel();
  const contentRange = response.headers.get('content-range');
  const match = contentRange?.match(/^bytes 0-0\/(\d+)$/);
  if (!match || Number(match[1]) !== expectedBytes) {
    throw new Error('video_seed_object_verify_size_mismatch');
  }
  return true;
}

async function storageFetch(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
): Promise<Response> {
  const dispatcher = getStorageDispatcher();
  return (await undiciFetch(url, {
    ...init,
    ...(dispatcher ? { dispatcher } : {}),
  })) as unknown as Response;
}

function getStorageDispatcher(): Dispatcher | undefined {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return undefined;
  storageDispatcher ??= new ProxyAgent(proxyUrl);
  return storageDispatcher;
}

function getTusProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return undefined;
  tusProxyAgent ??= new HttpsProxyAgent(proxyUrl);
  return tusProxyAgent;
}

function getProxyUrl(): string | undefined {
  const value = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  if (!value) return undefined;
  const parsed = new URL(value);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hash) {
    throw new Error('video_seed_proxy_url_invalid');
  }
  return parsed.toString();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
    apikey: config.supabase.serviceRoleKey,
    ...extra,
  };
}

function resumableEndpoint(): string {
  return `https://${config.database.projectRef}.storage.supabase.co/storage/v1/upload/resumable`;
}

function encodeObjectPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function assertEnvironment(confirmProjectRef: string): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('video_seed_tls_verification_disabled');
  }
  if (
    config.database.target !== 'test' ||
    !config.database.projectRef ||
    config.database.projectRef !== confirmProjectRef ||
    config.database.testProjectRef !== confirmProjectRef
  ) {
    throw new Error('video_seed_test_project_identity_mismatch');
  }
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error('video_seed_supabase_credentials_missing');
  }
  const url = new URL(config.supabase.url);
  if (url.protocol !== 'https:' || url.hostname !== `${confirmProjectRef}.supabase.co`) {
    throw new Error('video_seed_supabase_url_mismatch');
  }
}

function parseProcessedManifest(contents: string, manifestDirectory: string): ProcessedManifest {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== 'object') throw new Error('video_seed_processed_manifest_invalid');
  const manifest = value as ProcessedManifest;
  if (
    manifest.version !== 1 ||
    manifest.target !== 'test' ||
    manifest.phase !== 'processed' ||
    manifest.requestedRows !== 10 ||
    !Array.isArray(manifest.rows) ||
    manifest.rows.length !== 10 ||
    !Array.isArray(manifest.failures) ||
    manifest.failures.length !== 0
  ) {
    throw new Error('video_seed_processed_manifest_invalid');
  }
  for (const row of manifest.rows) {
    if (
      typeof row.sourceVideoId !== 'string' ||
      typeof row.videoPath !== 'string' ||
      typeof row.posterPath !== 'string' ||
      typeof row.videoStoragePath !== 'string' ||
      typeof row.posterStoragePath !== 'string' ||
      !Number.isSafeInteger(row.media?.videoBytes) ||
      !Number.isSafeInteger(row.media?.posterBytes) ||
      row.media.videoBytes < 1 ||
      row.media.posterBytes < 1 ||
      !isDescendant(manifestDirectory, row.videoPath) ||
      !isDescendant(manifestDirectory, row.posterPath) ||
      !/^media-plaza-video\/imports\/civitai\/[a-z0-9._-]+\/[a-f0-9]{64}\/video[.]mp4$/i.test(
        row.videoStoragePath
      ) ||
      !/^media-plaza-video\/imports\/civitai\/[a-z0-9._-]+\/[a-f0-9]{64}\/poster[.]jpg$/i.test(
        row.posterStoragePath
      )
    ) {
      throw new Error('video_seed_processed_manifest_invalid');
    }
  }
  return manifest;
}

function isDescendant(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '' && !value.startsWith('..') && !isAbsolute(value);
}

async function loadUploadState(
  path: string,
  manifestSha256: string,
  projectRef: string
): Promise<UploadState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('video_seed_upload_state_invalid');
    const state = value as UploadState;
    if (
      state.version !== 1 ||
      state.target !== 'test' ||
      state.projectRef !== projectRef ||
      state.processedManifestSha256 !== manifestSha256 ||
      !state.objects ||
      typeof state.objects !== 'object'
    ) {
      throw new Error('video_seed_upload_state_mismatch');
    }
    return state;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return {
        version: 1,
        target: 'test',
        projectRef,
        processedManifestSha256: manifestSha256,
        updatedAt: new Date().toISOString(),
        objects: {},
      };
    }
    throw err;
  }
}

async function saveUploadState(path: string, state: UploadState): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function parseArgs(args: string[]): {
  manifest: string;
  confirmProjectRef: string;
  concurrency: number;
  apply: boolean;
} {
  const result = { manifest: '', confirmProjectRef: '', concurrency: 4, apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => args[++index] ?? '';
    if (arg === '--manifest') result.manifest = value();
    else if (arg === '--confirm-project-ref') result.confirmProjectRef = value();
    else if (arg === '--concurrency') result.concurrency = integer(value(), 1, 4, arg);
    else if (arg === '--target') {
      if (value() !== 'test') throw new Error('video_seed_only_test_upload_is_enabled');
    } else if (arg === '--phase') {
      if (value() !== 'upload') throw new Error('video_seed_upload_phase_invalid');
    } else if (arg === '--apply') result.apply = true;
    else throw new Error(`unknown_argument:${arg ?? ''}`);
  }
  if (!result.manifest || !result.confirmProjectRef) {
    throw new Error('video_seed_upload_arguments_required');
  }
  if (!/^[a-z0-9]{20}$/.test(result.confirmProjectRef)) {
    throw new Error('video_seed_project_ref_invalid');
  }
  result.manifest = isAbsolute(result.manifest)
    ? result.manifest
    : resolve(process.env.INIT_CWD || process.cwd(), result.manifest);
  return result;
}

function integer(value: string, min: number, max: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid_integer:${name}`);
  }
  return parsed;
}
