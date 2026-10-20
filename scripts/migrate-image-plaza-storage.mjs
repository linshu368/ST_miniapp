import { readFile, writeFile, mkdir, rename, unlink, open, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'ops/exports/civitai-1792484619774');
const refs = { TEST: 'zoqelpfhurwehlvypryl', PROD: 'wbtsfzozlmurljvglhpn' };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fault = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });
const emit = (event, fields = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

export function validateManifest(bytes, summary) {
  // Git checkout converted this historical export to CRLF; validate canonical bytes, not a new snapshot.
  if (
    sha256(bytes) !== summary.storage_manifest_sha256 &&
    sha256(bytes.toString('utf8').replace(/\r\n/g, '\n')) !== summary.storage_manifest_sha256
  ) {
    throw fault('MANIFEST_HASH_MISMATCH');
  }
  const manifest = JSON.parse(bytes);
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  if (
    manifest.source_project_ref !== refs.TEST ||
    manifest.bucket !== 'image-plaza' ||
    manifest.objects.length !== 8032 ||
    summary.works !== 8032 ||
    manifest.objects.reduce((sum, item) => sum + item.byte_size, 0) !== 16637199531
  ) {
    throw fault('MANIFEST_SCOPE_MISMATCH');
  }
  const paths = new Set();
  for (const item of manifest.objects) {
    if (
      !/^\d+$/.test(item.source_image_id) ||
      !extensions[item.mime_type] ||
      item.path !==
        `image-plaza/imports/civitai/${item.source_image_id}.${extensions[item.mime_type]}` ||
      !Number.isSafeInteger(item.byte_size) ||
      item.byte_size < 1 ||
      item.byte_size > 52428800 ||
      paths.has(item.path.toLowerCase())
    )
      throw fault('UNSAFE_MANIFEST_OBJECT');
    paths.add(item.path.toLowerCase());
  }
  return manifest;
}

export function storageClient(origin, key, fetcher = fetch, timeout = 120000) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  async function request(path, options = {}) {
    try {
      return await fetcher(`${origin}/storage/v1/${path}`, {
        ...options,
        headers: { ...headers, ...options.headers },
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch {
      throw fault('NETWORK_OR_TIMEOUT', true);
    }
  }
  async function reject(response, allowMissing = false) {
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    // Storage can return HTTP 400 for a missing key. Never treat a permission error as absence.
    if (
      allowMissing &&
      (response.status === 404 ||
        (response.status === 400 &&
          (String(body.statusCode) === '404' || body.error === 'not_found')))
    )
      return null;
    if (response.status === 429) throw fault('RATE_LIMIT_STOP');
    throw fault(`HTTP_${response.status}`, response.status >= 500 || response.status === 408);
  }
  return {
    async bucket() {
      const response = await request('bucket/image-plaza');
      if (!response.ok) return reject(response);
      const bucket = await response.json();
      if (
        bucket.id !== 'image-plaza' ||
        bucket.public !== false ||
        Number(bucket.file_size_limit) < 52428800 ||
        !['image/jpeg', 'image/png', 'image/webp'].every((mime) =>
          bucket.allowed_mime_types?.includes(mime)
        )
      ) {
        throw fault('BUCKET_CONFIGURATION_MISMATCH');
      }
    },
    async download(item, allowMissing = false) {
      const response = await request(`object/authenticated/image-plaza/${item.path}`);
      if (!response.ok) return reject(response, allowMissing);
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const length = response.headers.get('content-length');
      if (mime !== item.mime_type || (length !== null && Number(length) !== item.byte_size)) {
        await response.body?.cancel();
        throw fault('OBJECT_METADATA_MISMATCH');
      }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > item.byte_size) throw fault('OBJECT_SIZE_MISMATCH');
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        if (error.code === 'OBJECT_SIZE_MISMATCH') throw error;
        throw fault('BODY_INTERRUPTED', true);
      }
      if (size !== item.byte_size) throw fault('OBJECT_SIZE_MISMATCH');
      return Buffer.concat(chunks, size);
    },
    async upload(item, bytes) {
      const response = await request(`object/image-plaza/${item.path}`, {
        method: 'POST',
        headers: { 'Content-Type': item.mime_type, 'x-upsert': 'false' },
        body: bytes,
      });
      // Duplicate/ambiguous responses are reconciled by reading the object; never enable upsert.
      if (response.status === 409) {
        await response.body?.cancel();
        return 'duplicate';
      }
      if (!response.ok) return reject(response);
      await response.body?.cancel();
      return 'created';
    },
  };
}

export async function retry(operation, sleep = pause) {
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!error.retryable || attempt === 2 || Date.now() - started > 270000) throw error;
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 500));
    }
  }
}

export async function ensureProduction(client, item, bytes, sleep = pause) {
  const digest = sha256(bytes);
  let attempted = false;
  let created = false;
  return retry(async () => {
    const existing = await client.download(item, true);
    if (existing !== null) {
      if (sha256(existing) !== digest) throw fault('PRODUCTION_CONTENT_CONFLICT');
      return created ? 'created' : attempted ? 'reconciled' : 'existing';
    }
    attempted = true;
    created = (await client.upload(item, bytes)) === 'created';
    const verified = await client.download(item);
    if (sha256(verified) !== digest) throw fault('PRODUCTION_HASH_MISMATCH');
    return created ? 'created' : 'reconciled';
  }, sleep);
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, bytes, { mode: 0o600 });
  await rename(`${path}.part`, path);
}

export function previouslyVerified(receipt, item, manifestHash, now = Date.now()) {
  if (receipt.production_verified_at === undefined) return false;
  const verifiedAt = Date.parse(receipt.production_verified_at);
  if (
    receipt.manifest_sha256 !== manifestHash ||
    receipt.byte_size !== item.byte_size ||
    receipt.mime_type !== item.mime_type ||
    typeof receipt.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    typeof receipt.production_verified_at !== 'string' ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now ||
    !['created', 'existing', 'reconciled'].includes(receipt.outcome)
  )
    throw fault('INVALID_VERIFIED_RECEIPT');
  return true;
}

export async function stageObject(client, item, staging, manifestHash) {
  const path = resolve(staging, item.path);
  const receiptPath = `${path}.json`;
  const previous = await readOptional(receiptPath);
  let bytes = await readOptional(path);
  if (previous) {
    const receipt = JSON.parse(previous);
    if (
      !bytes ||
      receipt.manifest_sha256 !== manifestHash ||
      receipt.sha256 !== sha256(bytes) ||
      bytes.length !== item.byte_size ||
      receipt.mime_type !== item.mime_type
    )
      throw fault('LOCAL_CACHE_CORRUPT');
    return { bytes, receipt, receiptPath, cached: true };
  }
  if (bytes) throw fault('LOCAL_FILE_WITHOUT_RECEIPT');
  bytes = await retry(() => client.download(item));
  const receipt = {
    manifest_sha256: manifestHash,
    sha256: sha256(bytes),
    byte_size: bytes.length,
    mime_type: item.mime_type,
    downloaded_at: new Date().toISOString(),
  };
  await atomicWrite(path, bytes);
  await atomicWrite(receiptPath, JSON.stringify(receipt));
  return { bytes, receipt, receiptPath, cached: false };
}

function useSystemProxy() {
  if (!process.argv.includes('--system-proxy') || process.env.NODE_USE_ENV_PROXY === '1')
    return false;
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-ItemProperty "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings").ProxyServer',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim();
  const proxy = raw.includes('=')
    ? raw
        .split(';')
        .find((entry) => entry.startsWith('https='))
        ?.slice(6)
    : raw;
  if (!proxy || !/^(http:\/\/)?(127\.0\.0\.1|localhost):\d+$/.test(proxy))
    throw fault('LOCAL_PROXY_NOT_RECOGNIZED');
  const child = spawnSync(process.execPath, ['--use-env-proxy', ...process.argv.slice(1)], {
    env: {
      ...process.env,
      HTTPS_PROXY: proxy.startsWith('http') ? proxy : `http://${proxy}`,
      NODE_USE_ENV_PROXY: '1',
    },
    stdio: 'inherit',
  });
  process.exitCode = child.status ?? 1;
  return true;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'Storage only: --execute [--canary] [--concurrency 1..8] [--system-proxy] [--resume-verified]. No SQL, deletes, or overwrite.'
    );
    return;
  }
  const allowed = new Set([
    '--execute',
    '--canary',
    '--concurrency',
    '--system-proxy',
    '--resume-verified',
  ]);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw fault('INVALID_ARGUMENTS');
    if (args[i] === '--concurrency') i++;
  }
  const concurrency = args.includes('--concurrency')
    ? Number(args[args.indexOf('--concurrency') + 1])
    : 6;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw fault('INVALID_CONCURRENCY');
  if (useSystemProxy()) return;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw fault('TLS_VERIFICATION_REQUIRED');
  const require = createRequire(resolve(root, 'packages/backend/package.json'));
  const env = require('dotenv').parse(await readFile(resolve(root, 'packages/backend/.env')));
  const clients = {};
  for (const [prefix, ref] of Object.entries(refs)) {
    const url = new URL(env[`${prefix}_SUPABASE_URL`]);
    const key = env[`${prefix}_SUPABASE_SERVICE_ROLE_KEY`];
    if (url.href !== `https://${ref}.supabase.co/` || !key)
      throw fault('ENVIRONMENT_CONFIG_MISMATCH');
    clients[prefix] = storageClient(url.origin, key);
  }
  const summary = JSON.parse(await readFile(resolve(directory, 'summary.json')));
  const manifest = validateManifest(
    await readFile(resolve(directory, 'storage-manifest.json')),
    summary
  );
  const staging = resolve(directory, 'storage-staging');
  execFileSync('git', ['check-ignore', '--quiet', '--', resolve(staging, 'probe')], {
    cwd: root,
    stdio: 'pipe',
  });
  await Promise.all(Object.values(clients).map((client) => retry(() => client.bucket())));
  emit('preflight_ok', {
    objects: manifest.objects.length,
    bytes: summary.image_bytes,
    concurrency,
  });
  if (!args.includes('--execute')) return;
  await mkdir(staging, { recursive: true });
  const space = await statfs(staging);
  // Conservative even on resume: retain a complete original copy plus in-flight files.
  if (space.bavail * space.bsize < summary.image_bytes + 1073741824)
    throw fault('LOCAL_SPACE_INSUFFICIENT');
  const lockPath = resolve(staging, 'migration.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const canary = args.includes('--canary');
  const resumeVerified = args.includes('--resume-verified');
  let items = manifest.objects;
  if (canary) {
    const selected = new Map();
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const group = items
        .filter((item) => item.mime_type === mime)
        .sort((a, b) => b.byte_size - a.byte_size);
      for (const item of [...group.slice(0, 2), ...group.slice(-2)]) selected.set(item.path, item);
    }
    for (const item of items) {
      if (selected.size >= 12) break;
      selected.set(item.path, item);
    }
    items = [...selected.values()];
  }
  const report = {
    started_at: new Date().toISOString(),
    phase: canary ? 'canary' : 'full',
    verification_mode: resumeVerified ? 'cumulative_receipts' : 'full_readback',
    total: items.length,
    completed: 0,
    bytes: 0,
    downloaded: 0,
    cached: 0,
    created: 0,
    existing: 0,
    reconciled: 0,
    prior_verified: 0,
    failed: 0,
  };
  let cursor = 0;
  let stopped = false;
  const timer = setInterval(() => emit('progress', report), 30000);
  const signalHandler = () => {
    stopped = true;
    emit('stop_requested');
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (!stopped && cursor < items.length) {
          const item = items[cursor++];
          try {
            const local = await stageObject(
              clients.TEST,
              item,
              staging,
              summary.storage_manifest_sha256
            );
            report[local.cached ? 'cached' : 'downloaded']++;
            // Explicit opt-in trusts prior remote validation, not just local file existence.
            // Keep the original receipt timestamp: this is not a fresh remote readback.
            if (
              resumeVerified &&
              previouslyVerified(local.receipt, item, summary.storage_manifest_sha256)
            ) {
              report.prior_verified++;
              report.completed++;
              report.bytes += item.byte_size;
              if (report.completed % 100 === 0) emit('progress', report);
              continue;
            }
            const outcome = await ensureProduction(clients.PROD, item, local.bytes);
            await atomicWrite(
              local.receiptPath,
              JSON.stringify({
                ...local.receipt,
                production_verified_at: new Date().toISOString(),
                outcome,
                first_outcome: local.receipt.first_outcome ?? outcome,
              })
            );
            report[outcome]++;
            report.completed++;
            report.bytes += item.byte_size;
            if (report.completed % 100 === 0) emit('progress', report);
          } catch (error) {
            stopped = true;
            report.failed++;
            const code = /^[A-Z0-9_]+$/.test(error.code ?? '')
              ? error.code
              : 'VALIDATION_OR_IO_ERROR';
            // Hash identifies the failed entry without exposing the manifest in console logs.
            emit('object_failed', { object_hash: sha256(item.path), code });
            await atomicWrite(
              resolve(staging, `failure-${sha256(item.path)}.json`),
              JSON.stringify({ path: item.path, code })
            );
          }
        }
      })
    );
    report.finished_at = new Date().toISOString();
    report.success = report.completed === report.total && report.failed === 0;
    await atomicWrite(
      resolve(staging, `${canary ? 'canary' : 'full'}-report.json`),
      JSON.stringify(report, null, 2)
    );
    emit('finished', report);
    if (!report.success) process.exitCode = 1;
  } finally {
    clearInterval(timer);
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    emit('migration_failed', {
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'VALIDATION_OR_IO_ERROR',
    });
    process.exitCode = 1;
  });
}
