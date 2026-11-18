import '../platform/config.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { config } from '../platform/config.js';

const BUCKET = 'media-plaza-video';
const RANGE_BYTES = 256 * 1024;
let dispatcher: ProxyAgent | undefined;

interface ManifestRow {
  sourceVideoId: string;
  videoStoragePath: string;
  media: { videoBytes: number };
}

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  assertEnvironment(options.confirmProjectRef);
  const rows = parseRows(await readFile(options.manifest, 'utf8'));
  const results: Array<{ startMs: number; seekMs: number }> = [];
  for (const row of rows) {
    const signedUrl = await signPath(row.videoStoragePath);
    const startMs = await timeRange(
      signedUrl,
      0,
      Math.min(RANGE_BYTES - 1, row.media.videoBytes - 1)
    );
    const seekStart = Math.max(0, Math.floor(row.media.videoBytes / 2));
    const seekMs = await timeRange(
      signedUrl,
      seekStart,
      Math.min(row.media.videoBytes - 1, seekStart + RANGE_BYTES - 1)
    );
    results.push({ startMs, seekMs });
    console.log(
      `video playback range id=${row.sourceVideoId} start_ms=${startMs.toFixed(1)} seek_ms=${seekMs.toFixed(1)} signed_url_reused=true`
    );
  }
  const startP95 = percentile(
    results.map((result) => result.startMs),
    0.95
  );
  const seekP95 = percentile(
    results.map((result) => result.seekMs),
    0.95
  );
  console.log(
    `video playback range complete rows=${rows.length} start_p95_ms=${startP95.toFixed(1)} seek_p95_ms=${seekP95.toFixed(1)} budget_ms=2000`
  );
  if (startP95 > 2_000 || seekP95 > 2_000) exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : 'video_seed_playback_validation_failed');
  exitCode = 1;
} finally {
  await dispatcher?.destroy().catch(() => {
    exitCode = 1;
  });
}
process.exitCode = exitCode;

async function signPath(path: string): Promise<string> {
  const response = await storageFetch(
    `${config.supabase.url}/storage/v1/object/sign/${BUCKET}/${encodePath(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        apikey: config.supabase.serviceRoleKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 600 }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!response.ok) throw new Error(`video_seed_sign_${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('video_seed_sign_invalid');
  const pathOrUrl =
    (value as { signedURL?: unknown; signedUrl?: unknown }).signedURL ??
    (value as { signedUrl?: unknown }).signedUrl;
  if (typeof pathOrUrl !== 'string' || !pathOrUrl) throw new Error('video_seed_sign_invalid');
  const signedUrl = pathOrUrl.startsWith('https://')
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl.replace(/^\/+/, ''), `${config.supabase.url}/storage/v1/`);
  if (
    signedUrl.protocol !== 'https:' ||
    signedUrl.hostname !== new URL(config.supabase.url).hostname
  ) {
    throw new Error('video_seed_sign_host_invalid');
  }
  return signedUrl.toString();
}

async function timeRange(url: string, start: number, end: number): Promise<number> {
  const startedAt = performance.now();
  const response = await storageFetch(url, {
    method: 'GET',
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(10_000),
  });
  const headersAt = performance.now();
  if (response.status !== 206) throw new Error(`video_seed_signed_range_${response.status}`);
  const contentRange = response.headers.get('content-range');
  if (!contentRange?.startsWith(`bytes ${start}-${end}/`)) {
    throw new Error('video_seed_signed_range_invalid');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== end - start + 1) throw new Error('video_seed_signed_range_size_invalid');
  return headersAt - startedAt;
}

async function storageFetch(
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  }
): Promise<Response> {
  const proxy = getDispatcher();
  return (await undiciFetch(url, {
    ...init,
    ...(proxy ? { dispatcher: proxy } : {}),
  })) as unknown as Response;
}

function getDispatcher(): Dispatcher | undefined {
  const value = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash) {
    throw new Error('video_seed_proxy_url_invalid');
  }
  dispatcher ??= new ProxyAgent(url.toString());
  return dispatcher;
}

function parseRows(contents: string): ManifestRow[] {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== 'object') throw new Error('video_seed_manifest_invalid');
  const manifest = value as { target?: unknown; phase?: unknown; rows?: unknown };
  if (
    manifest.target !== 'test' ||
    manifest.phase !== 'processed' ||
    !Array.isArray(manifest.rows)
  ) {
    throw new Error('video_seed_manifest_invalid');
  }
  const rows = manifest.rows as ManifestRow[];
  if (rows.length !== 10) throw new Error('video_seed_manifest_invalid');
  for (const row of rows) {
    if (
      typeof row.sourceVideoId !== 'string' ||
      !/^media-plaza-video\/imports\/civitai\/[a-z0-9._-]+\/[a-f0-9]{64}\/video[.]mp4$/i.test(
        row.videoStoragePath
      ) ||
      !Number.isSafeInteger(row.media?.videoBytes) ||
      row.media.videoBytes < 1
    ) {
      throw new Error('video_seed_manifest_invalid');
    }
  }
  return rows;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function assertEnvironment(projectRef: string): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('video_seed_tls_verification_disabled');
  }
  if (
    config.database.target !== 'test' ||
    config.database.projectRef !== projectRef ||
    config.database.testProjectRef !== projectRef
  ) {
    throw new Error('video_seed_test_project_identity_mismatch');
  }
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error('video_seed_supabase_credentials_missing');
  }
}

function parseArgs(args: string[]): { manifest: string; confirmProjectRef: string } {
  const result = { manifest: '', confirmProjectRef: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => args[++index] ?? '';
    if (arg === '--manifest') result.manifest = value();
    else if (arg === '--confirm-project-ref') result.confirmProjectRef = value();
    else if (arg === '--target') {
      if (value() !== 'test') throw new Error('video_seed_only_test_validation_is_enabled');
    } else throw new Error(`unknown_argument:${arg ?? ''}`);
  }
  if (!result.manifest || !/^[a-z0-9]{20}$/.test(result.confirmProjectRef)) {
    throw new Error('video_seed_playback_arguments_required');
  }
  result.manifest = isAbsolute(result.manifest)
    ? result.manifest
    : resolve(process.env.INIT_CWD || process.cwd(), result.manifest);
  return result;
}
