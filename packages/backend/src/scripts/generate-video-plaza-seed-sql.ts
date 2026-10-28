import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VideoPlazaModelCatalogSchema, type VideoPlazaModelCatalog } from '@miniapp/shared';

interface ProcessedRow {
  selectionIndex: number;
  sourceModelName: string;
  modelId: string;
  prompt: string;
  promptZh: string;
  videoUrl: string;
  sourceVideoId: string;
  sourceHeat: number;
  publishedAt: string;
  videoStoragePath: string;
  posterStoragePath: string;
  media: {
    videoBytes: number;
    posterBytes: number;
    width: number;
    height: number;
    posterWidth: number;
    posterHeight: number;
    durationMs: number;
  };
}

interface ProcessedManifest {
  version: number;
  target: string;
  phase: string;
  requestedRows: number;
  rows: ProcessedRow[];
  failures: unknown[];
}

interface UploadState {
  version: number;
  target: string;
  projectRef: string;
  processedManifestSha256: string;
  objects: Record<string, { verified?: unknown; bytes?: unknown }>;
}

interface SqlPayloadRow {
  source_video_id: string;
  source_video_url: string;
  source_heat: number;
  storage_path: string;
  byte_size: number;
  width: number;
  height: number;
  duration_ms: number;
  poster_path: string;
  poster_width: number;
  poster_height: number;
  poster_byte_size: number;
  title: string;
  description: string;
  model_id: string;
  model_name: string;
  snapshot: Record<string, unknown>;
  published_at: string;
}

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  const [manifestBytes, uploadStateValue, catalogValue] = await Promise.all([
    readFile(options.manifest),
    readJson(options.uploadState),
    readJson(options.catalog),
  ]);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  const uploadState = parseUploadState(uploadStateValue, manifestSha256, options.confirmProjectRef);
  const catalog = VideoPlazaModelCatalogSchema.parse(catalogValue);
  const payload = buildPayload(manifest, uploadState, catalog);
  const sql = renderSql(payload, options.confirmProjectRef, manifestSha256);
  assertMigrationOutputPath(options.output);
  await writeFile(options.output, sql, { encoding: 'utf8', flag: 'wx' });
  const sqlSha256 = createHash('sha256').update(sql).digest('hex');
  console.log(
    `video seed SQL generated target=test rows=${payload.length} output=${options.output} sha256=${sqlSha256}`
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : 'video_seed_sql_generation_failed');
  exitCode = 1;
}
process.exitCode = exitCode;

function buildPayload(
  manifest: ProcessedManifest,
  uploadState: UploadState,
  catalog: VideoPlazaModelCatalog
): SqlPayloadRow[] {
  const models = new Map(catalog.models.map((model) => [model.id, model] as const));
  return [...manifest.rows]
    .sort((left, right) => left.selectionIndex - right.selectionIndex)
    .map((row) => {
      assertVerifiedObject(uploadState, row.videoStoragePath, row.media.videoBytes);
      assertVerifiedObject(uploadState, row.posterStoragePath, row.media.posterBytes);
      const model = models.get(row.modelId);
      if (!model || !model.enabled)
        throw new Error(`video_seed_catalog_model_unavailable:${row.modelId}`);
      if (model.name !== row.sourceModelName && !model.seed_aliases.includes(row.sourceModelName)) {
        throw new Error(`video_seed_catalog_model_mismatch:${row.modelId}`);
      }
      const duration = model.durations.reduce(
        (best, value) =>
          Math.abs(value * 1000 - row.media.durationMs) <
          Math.abs(best * 1000 - row.media.durationMs)
            ? value
            : best,
        model.default_duration
      );
      const snapshot: Record<string, unknown> = {
        prompt: row.prompt,
        prompt_zh: row.promptZh,
        prompt_zh_source: 'translation_pack',
        model_id: model.id,
        input_mode: model.image_input === 'required_reference' ? 'r2v' : 't2v',
        duration_s: duration,
        resolution: model.default_resolution,
        aspect_ratio: model.default_aspect_ratio,
        audio: model.default_audio,
        reference_artifact_id: null,
        source_heat: row.sourceHeat,
      };
      return {
        source_video_id: row.sourceVideoId,
        source_video_url: row.videoUrl,
        source_heat: row.sourceHeat,
        storage_path: row.videoStoragePath,
        byte_size: row.media.videoBytes,
        width: row.media.width,
        height: row.media.height,
        duration_ms: row.media.durationMs,
        poster_path: row.posterStoragePath,
        poster_width: row.media.posterWidth,
        poster_height: row.media.posterHeight,
        poster_byte_size: row.media.posterBytes,
        title: row.promptZh.slice(0, 80),
        description: row.promptZh.slice(0, 500),
        model_id: model.id,
        model_name: model.name,
        snapshot,
        published_at: row.publishedAt,
      };
    });
}

function renderSql(payload: SqlPayloadRow[], projectRef: string, manifestSha256: string): string {
  const payloadHex = Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
  return `-- domain: media_plaza
-- TEST-only data migration generated from verified private Storage objects.
-- project_ref: ${projectRef}
-- processed_manifest_sha256: ${manifestSha256}
-- Execute only through the repository Database Migration workflow. The workflow injects
-- the TEST identity and approval settings into this migration's psql session.
-- Recovery: transaction failure rolls back all 10 DB rows. Storage objects are immutable and retained.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL standard_conforming_strings = on;

DO $bootstrap$
DECLARE
  v_payload JSONB := convert_from(decode('${payloadHex}', 'hex'), 'UTF8')::JSONB;
  v_row JSONB;
  v_result JSONB;
  v_inserted INTEGER := 0;
  v_unchanged INTEGER := 0;
BEGIN
  IF current_setting('app.seed_target', true) IS DISTINCT FROM 'test'
     OR current_setting('app.seed_project_ref', true) IS DISTINCT FROM '${projectRef}'
     OR current_setting('app.seed_storage_verified', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'TEST identity, Storage verification and execution approval are required';
  END IF;
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_payload) <> 10 THEN
    RAISE EXCEPTION 'TEST video seed payload must contain exactly 10 rows';
  END IF;
  IF (SELECT count(DISTINCT value->>'source_video_id') FROM jsonb_array_elements(v_payload)) <> 10 THEN
    RAISE EXCEPTION 'duplicate or missing video seed source ID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'media-plaza-video' AND public = false
      AND (file_size_limit IS NULL OR file_size_limit >= 209715200)
  ) THEN
    RAISE EXCEPTION 'private media-plaza-video bucket with 200MiB capacity required';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(v_payload)
    ORDER BY (value->>'source_video_id')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM storage.objects
      WHERE bucket_id = 'media-plaza-video'
        AND name = v_row->>'storage_path'
        AND (metadata->>'size')::BIGINT = (v_row->>'byte_size')::BIGINT
        AND metadata->>'mimetype' = 'video/mp4'
    ) OR NOT EXISTS (
      SELECT 1 FROM storage.objects
      WHERE bucket_id = 'media-plaza-video'
        AND name = v_row->>'poster_path'
        AND (metadata->>'size')::BIGINT = (v_row->>'poster_byte_size')::BIGINT
        AND metadata->>'mimetype' = 'image/jpeg'
    ) THEN
      RAISE EXCEPTION 'video seed Storage object missing or metadata mismatch';
    END IF;

    v_result := media_plaza.import_video_seed_work(
      v_row->>'source_video_id', v_row->>'source_video_url',
      (v_row->>'source_heat')::INTEGER, v_row->>'storage_path',
      (v_row->>'byte_size')::BIGINT, (v_row->>'width')::INTEGER,
      (v_row->>'height')::INTEGER, (v_row->>'duration_ms')::INTEGER,
      v_row->>'poster_path', (v_row->>'poster_width')::INTEGER,
      (v_row->>'poster_height')::INTEGER, v_row->>'title', v_row->>'description',
      v_row->>'model_id', v_row->>'model_name', v_row->'snapshot',
      (v_row->>'published_at')::TIMESTAMPTZ
    );
    IF v_result->>'already_imported' = 'true' THEN
      v_unchanged := v_unchanged + 1;
    ELSIF v_result->>'already_imported' = 'false' THEN
      v_inserted := v_inserted + 1;
    ELSE
      RAISE EXCEPTION 'unexpected video seed RPC result';
    END IF;
  END LOOP;
  RAISE NOTICE 'TEST video seed completed: inserted=%, unchanged=%', v_inserted, v_unchanged;
END;
$bootstrap$;
COMMIT;
`;
}

function parseManifest(contents: string): ProcessedManifest {
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
  const sourceIds = new Set<string>();
  const selectionIndexes = new Set<number>();
  for (const row of manifest.rows) {
    if (
      !Number.isSafeInteger(row.selectionIndex) ||
      row.selectionIndex < 0 ||
      row.selectionIndex >= 10 ||
      selectionIndexes.has(row.selectionIndex) ||
      typeof row.sourceVideoId !== 'string' ||
      !row.sourceVideoId ||
      sourceIds.has(row.sourceVideoId) ||
      typeof row.modelId !== 'string' ||
      typeof row.sourceModelName !== 'string' ||
      typeof row.prompt !== 'string' ||
      !row.prompt ||
      typeof row.promptZh !== 'string' ||
      !row.promptZh ||
      typeof row.videoUrl !== 'string' ||
      !row.videoUrl.startsWith('https://image.civitai.com/') ||
      !Number.isSafeInteger(row.sourceHeat) ||
      row.sourceHeat < 0 ||
      !Number.isSafeInteger(row.media?.videoBytes) ||
      row.media.videoBytes < 1 ||
      !Number.isSafeInteger(row.media?.posterBytes) ||
      row.media.posterBytes < 1 ||
      !Number.isSafeInteger(row.media?.width) ||
      !Number.isSafeInteger(row.media?.height) ||
      !Number.isSafeInteger(row.media?.posterWidth) ||
      !Number.isSafeInteger(row.media?.posterHeight) ||
      !Number.isSafeInteger(row.media?.durationMs) ||
      !/^media-plaza-video\/imports\/civitai\/[a-z0-9._-]+\/[a-f0-9]{64}\/video[.]mp4$/i.test(
        row.videoStoragePath
      ) ||
      !/^media-plaza-video\/imports\/civitai\/[a-z0-9._-]+\/[a-f0-9]{64}\/poster[.]jpg$/i.test(
        row.posterStoragePath
      )
    ) {
      throw new Error('video_seed_processed_manifest_invalid');
    }
    selectionIndexes.add(row.selectionIndex);
    sourceIds.add(row.sourceVideoId);
  }
  if (new Set(manifest.rows.map((row) => row.modelId)).size !== 6) {
    throw new Error('video_seed_test_model_coverage_invalid');
  }
  return manifest;
}

function parseUploadState(value: unknown, manifestSha256: string, projectRef: string): UploadState {
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
}

function assertVerifiedObject(state: UploadState, path: string, bytes: number): void {
  const object = state.objects[path];
  if (!object || object.verified !== true || object.bytes !== bytes) {
    throw new Error(`video_seed_upload_not_verified:${path}`);
  }
}

function assertMigrationOutputPath(output: string): void {
  const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const migrationRoot = resolve(workspaceRoot, 'packages/shared/migrations');
  const relativePath = relative(migrationRoot, output);
  if (
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    !/^202\d{5}_media_plaza_video_seed_test_10[.]sql$/.test(relativePath)
  ) {
    throw new Error('video_seed_sql_output_must_be_test_migration');
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function parseArgs(args: string[]): {
  manifest: string;
  uploadState: string;
  catalog: string;
  output: string;
  confirmProjectRef: string;
} {
  const result = { manifest: '', uploadState: '', catalog: '', output: '', confirmProjectRef: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => args[++index] ?? '';
    if (arg === '--processed-manifest') result.manifest = value();
    else if (arg === '--upload-state') result.uploadState = value();
    else if (arg === '--catalog') result.catalog = value();
    else if (arg === '--output') result.output = value();
    else if (arg === '--confirm-project-ref') result.confirmProjectRef = value();
    else if (arg === '--target') {
      if (value() !== 'test') throw new Error('video_seed_only_test_sql_is_enabled');
    } else throw new Error(`unknown_argument:${arg ?? ''}`);
  }
  if (
    !result.manifest ||
    !result.uploadState ||
    !result.catalog ||
    !result.output ||
    !result.confirmProjectRef
  ) {
    throw new Error('video_seed_sql_arguments_required');
  }
  if (!/^[a-z0-9]{20}$/.test(result.confirmProjectRef)) {
    throw new Error('video_seed_project_ref_invalid');
  }
  const path = (value: string) =>
    isAbsolute(value) ? value : resolve(process.env.INIT_CWD || process.cwd(), value);
  result.manifest = path(result.manifest);
  result.uploadState = path(result.uploadState);
  result.catalog = path(result.catalog);
  result.output = path(result.output);
  return result;
}
