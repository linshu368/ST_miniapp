import { withBusinessContext } from '../platform/observability/context.js';
import { runObservedJob, finishBackgroundOperation } from '../platform/observability/jobs.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir, open, unlink, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../platform/config.js';
import { getDomainDb } from '../lib/supabase.js';
import { clientFetch } from '../platform/observability/fetch.js';
import { observation } from '../platform/observability/runtime.js';
import {
  readStreamBody,
  streamRequest,
  VideoStreamError,
  requireVideoStreamConfig,
} from '../features/image-plaza/video-stream-client.js';
import {
  createStreamUpload,
  uploadStreamChunk,
} from '../features/image-plaza/video-stream-upload.js';
import { verifyStreamReady } from '../features/image-plaza/video-stream-playback.js';
import {
  assertAssetSet,
  hashVideo,
  loadMigrationState,
  saveMigrationState,
  renderStreamMigrationSql,
  TEST_VIDEO_PROJECT,
  type MigrationAsset,
  type MigrationState,
} from './video-stream-migration-state.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const args = process.argv.slice(2);
const phase = argument('--phase');
const directory = resolve(argument('--directory'));
const statePath = join(directory, 'stream-state.json');
const db = getDomainDb('media_plaza');

async function main() {
  assertTest();
  const local = relative(root, directory);
  if (!local.startsWith('..') && !isAbsolute(local))
    throw new Error('video_migration_backup_must_be_outside_repo');
  await mkdir(directory, { recursive: true });
  const lock = await open(join(directory, '.migration-lock'), 'wx');
  try {
    if (phase === 'preflight') {
      await preflight();
      return;
    }
    const state = await loadMigrationState(statePath);
    const stream = requireVideoStreamConfig();
    if (
      argument('--confirm-account') !== stream.accountId ||
      (state.account_id && state.account_id !== stream.accountId)
    )
      throw new Error('video_migration_account_mismatch');
    state.account_id = stream.accountId;
    if (phase === 'upload') {
      const quota = z
        .object({
          totalStorageMinutes: z.number().nonnegative(),
          totalStorageMinutesLimit: z.number().positive(),
        })
        .parse(await streamRequest('/storage-usage'));
      const needed = state.assets.reduce(
        (sum, asset) => sum + Math.ceil(asset.duration_ms / 1000) / 60,
        0
      );
      if (quota.totalStorageMinutesLimit - quota.totalStorageMinutes < needed + 1)
        throw new Error('video_migration_storage_capacity_insufficient');
      await upload(state);
    } else if (phase === 'verify') await verify(state);
    else if (phase === 'sql')
      await writeFile(
        join(root, 'packages/shared/migrations/20261117_media_plaza_stream_test_assets.sql'),
        renderStreamMigrationSql(state, stream.host),
        { flag: 'wx' }
      );
    else if (phase === 'cleanup') await cleanup(state);
    else throw new Error('video_migration_phase_invalid');
  } finally {
    await lock.close();
    await unlink(join(directory, '.migration-lock'));
  }
}

function argument(name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value || value.startsWith('--'))
    throw new Error(`missing_${name.slice(2).replaceAll('-', '_')}`);
  return value;
}

function assertTest() {
  if (
    config.database.target !== 'test' ||
    config.database.projectRef !== TEST_VIDEO_PROJECT ||
    new URL(config.supabase.url).hostname !== `${TEST_VIDEO_PROJECT}.supabase.co`
  )
    throw new Error('video_migration_requires_test_project');
}

async function sourceRows() {
  const result = await db
    .from('video_artifacts')
    .select('id,origin,storage_path,poster_path,byte_size,width,height,duration_ms')
    .order('id')
    .limit(14);
  if (result.error) throw new Error('video_migration_source_read_failed', { cause: result.error });
  const rows = result.data as Omit<MigrationAsset, 'sha256' | 'stage'>[];
  assertAssetSet(rows);
  return rows;
}

async function preflight() {
  try {
    await stat(statePath);
    throw new Error('video_migration_checkpoint_exists');
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  const rows = await sourceRows();
  const assets: MigrationAsset[] = [];
  for (const row of rows) {
    await withBusinessContext({ artifact_id: row.id }, async () => {
      const path = row.storage_path.split('/').map(encodeURIComponent).join('/');
      const response = await clientFetch('video.migration.backup', 'supabase')(
        `${config.supabase.url}/storage/v1/object/authenticated/media-plaza-video/${path}`,
        {
          headers: {
            Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
            apikey: config.supabase.serviceRoleKey,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
        }
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('video_migration_source_unreadable');
      }
      const bytes = await readStreamBody(response, row.byte_size);
      if (bytes.length !== row.byte_size) throw new Error('video_migration_source_size_changed');
      const sha256 = hashVideo(bytes);
      const destination = join(directory, `${row.id}.mp4`);
      await writeFile(destination, bytes, { mode: 0o600 });
      if (hashVideo(await readFile(destination)) !== sha256)
        throw new Error('video_migration_backup_hash_failed');
      assets.push({ ...row, sha256, stage: 'backed_up' });
      progress('backup', assets.length);
    });
  }
  const state: MigrationState = {
    version: 1,
    target: 'test',
    project_ref: TEST_VIDEO_PROJECT,
    account_id: null,
    app_verified: false,
    assets,
  };
  await saveMigrationState(statePath, state);
}

async function backup(asset: MigrationAsset) {
  const bytes = await readFile(join(directory, `${asset.id}.mp4`));
  if (bytes.length !== asset.byte_size || hashVideo(bytes) !== asset.sha256)
    throw new Error('video_migration_backup_changed');
  return bytes;
}

async function upload(state: MigrationState) {
  const rows = await sourceRows();
  if (
    rows.some(
      (row) =>
        !state.assets.some(
          (a) =>
            a.id === row.id && a.storage_path === row.storage_path && a.byte_size === row.byte_size
        )
    )
  )
    throw new Error('video_migration_source_set_changed');
  for (const asset of state.assets) {
    await withBusinessContext({ artifact_id: asset.id }, async () => {
      if (['uploaded', 'verified', 'cleaned'].includes(asset.stage)) return;
      if (asset.stage === 'creating')
        throw new Error('video_migration_create_unknown_reconcile_first');
      const bytes = await backup(asset);
      if (!asset.session) {
        asset.stage = 'creating';
        await saveMigrationState(statePath, state);
        asset.session = await createStreamUpload(bytes, asset.id, asset.duration_ms / 1000 + 3);
        asset.stage = 'uploading';
        await saveMigrationState(statePath, state);
      }
      for (let chunks = 0; chunks < 42; chunks++) {
        if (await uploadStreamChunk(asset.session, bytes)) {
          asset.stage = 'uploaded';
          break;
        }
      }
      if (asset.stage !== 'uploaded') throw new Error('video_migration_chunk_budget_exceeded');
      asset.session.uploadUrl = '';
      await saveMigrationState(statePath, state);
      progress(
        'upload',
        state.assets.filter((a) => ['uploaded', 'verified'].includes(a.stage)).length
      );
    });
  }
}

async function verify(state: MigrationState) {
  for (const asset of state.assets) {
    await withBusinessContext({ artifact_id: asset.id }, async () => {
      await backup(asset);
      if (!asset.session || !['uploaded', 'verified'].includes(asset.stage))
        throw new Error('video_migration_upload_incomplete');
      const media = await verifyStreamReady(asset.session.uid);
      if (!media) {
        progress('encoding', state.assets.filter((a) => a.stage === 'verified').length);
        return;
      }
      if (
        media.width !== asset.width ||
        media.height !== asset.height ||
        Math.abs(media.durationMs - asset.duration_ms) > 1500
      )
        throw new Error('video_migration_dimensions_changed');
      asset.stage = 'verified';
      asset.rendition_count = media.renditionCount;
      await saveMigrationState(statePath, state);
    });
  }
  progress('verify', state.assets.filter((a) => a.stage === 'verified').length);
}

async function cleanup(state: MigrationState) {
  if (
    argument('--confirm-app-verified') !== '13/13' ||
    state.assets.some((a) => !['verified', 'cleaned'].includes(a.stage))
  )
    throw new Error('video_migration_app_verification_required');
  const result = await db
    .from('video_artifacts')
    .select('id,stream_uid,poster_path')
    .order('id')
    .limit(14);
  if (
    result.error ||
    result.data?.length !== 13 ||
    result.data.some(
      (row) =>
        !state.assets.some(
          (a) =>
            a.id === row.id &&
            a.session?.uid === row.stream_uid &&
            a.poster_path === row.poster_path
        )
    )
  )
    throw new Error('video_migration_database_mapping_mismatch');
  for (const asset of state.assets) {
    await withBusinessContext({ artifact_id: asset.id }, async () => {
      await backup(asset);
      if (asset.stage === 'cleaned') return;
      if (!(await verifyStreamReady(asset.session!.uid)))
        throw new Error('video_migration_playback_not_ready');
      const deleted = await clientFetch('video.delivery.cleanup', 'supabase')(
        `${config.supabase.url}/storage/v1/object/media-plaza-video`,
        {
          method: 'DELETE',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
            apikey: config.supabase.serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prefixes: [asset.storage_path] }),
        }
      );
      await deleted.body?.cancel();
      if (!deleted.ok) throw new Error('video_migration_cleanup_failed');
      asset.stage = 'cleaned';
      state.app_verified = true;
      await saveMigrationState(statePath, state);
      progress('cleanup', state.assets.filter((a) => a.stage === 'cleaned').length);
    });
  }
}

function progress(stage: string, count: number) {
  observation.emit('video.migration.progress', 'video.delivery.migration', {
    provider: stage === 'backup' ? 'supabase' : 'cloudflare',
    stage,
    count,
    outcome: 'succeeded',
    outcome_known: true,
  });
}

await runObservedJob('video_plaza_migration', () =>
  withBusinessContext({ business_module: 'image' }, async () => {
    await main();
    finishBackgroundOperation('video_plaza_migration', {
      outcome: 'succeeded',
      outcome_known: true,
    });
  })
).catch((err) => {
  observation.emit('video.migration.failed', 'video.delivery.migration', {
    outcome: 'failed',
    outcome_known: false,
    error_code:
      err instanceof VideoStreamError
        ? err.code
        : err instanceof Error && /^video_migration_[a-z0-9_]{1,100}$/.test(err.message)
          ? err.message
          : 'video_migration_unknown',
    err,
  });
  process.exitCode = 1;
});
