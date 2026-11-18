import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

export const TEST_VIDEO_PROJECT = 'zoqelpfhurwehlvypryl';
export const MigrationAssetSchema = z.object({
  id: z.string().uuid(),
  origin: z.enum(['civitai_seed', 'generated']),
  storage_path: z
    .string()
    .regex(/^media-plaza-video\/(?:attempts|imports)\/[a-zA-Z0-9._/-]+\/video\.mp4$/),
  poster_path: z.string().nullable(),
  byte_size: z.number().int().positive().max(209715200),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration_ms: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  stage: z.enum(['backed_up', 'creating', 'uploading', 'uploaded', 'verified', 'cleaned']),
  session: z
    .object({
      uid: z.string().regex(/^[a-f0-9]{32}$/),
      uploadUrl: z.string(),
      byteSize: z.number().int().positive(),
      sha256: z.string(),
    })
    .optional(),
  rendition_count: z.number().int().positive().optional(),
});
export type MigrationAsset = z.infer<typeof MigrationAssetSchema>;
export const MigrationStateSchema = z
  .object({
    version: z.literal(1),
    target: z.literal('test'),
    project_ref: z.literal(TEST_VIDEO_PROJECT),
    account_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    app_verified: z.boolean().default(false),
    assets: z.array(MigrationAssetSchema).length(13),
  })
  .strict();
export type MigrationState = z.infer<typeof MigrationStateSchema>;

export function hashVideo(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export async function loadMigrationState(path: string) {
  const state = MigrationStateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  assertAssetSet(state.assets);
  return state;
}
export function assertAssetSet(
  assets: Array<{ id: string; origin: string; storage_path: string }>
) {
  if (
    assets.length !== 13 ||
    new Set(assets.map((a) => a.id)).size !== 13 ||
    new Set(assets.map((a) => a.storage_path)).size !== 13 ||
    assets.filter((a) => a.origin === 'civitai_seed').length !== 10 ||
    assets.filter((a) => a.origin === 'generated').length !== 3
  )
    throw new Error('video_migration_asset_set_changed');
}
export async function saveMigrationState(path: string, state: MigrationState) {
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** SQL is generated only after real Stream verification; no direct business-table writes. */
export function renderStreamMigrationSql(state: MigrationState, host: string): string {
  if (!/^customer-[a-zA-Z0-9-]+\.cloudflarestream\.com$/.test(host))
    throw new Error('video_migration_host_invalid');
  if (!state.account_id || state.assets.some((a) => a.stage !== 'verified' || !a.session))
    throw new Error('video_migration_not_verified');
  const uids = state.assets.map((a) => a.session!.uid);
  if (new Set(uids).size !== 13) throw new Error('video_migration_duplicate_uid');
  const payload = state.assets.map((a) => ({
    id: a.id,
    path: a.storage_path,
    bytes: a.byte_size,
    uid: a.session!.uid,
  }));
  const hex = Buffer.from(JSON.stringify(payload)).toString('hex');
  return `-- domain: media_plaza
-- TEST only, all 13 Stream assets verified. Preserve business IDs, posters and billing.
-- Execute through Database Migration; rollback before contraction restores paths from independent backup manifest.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $stream$
DECLARE rows JSONB := convert_from(decode('${hex}','hex'),'UTF8')::JSONB; r JSONB; changed INTEGER;
BEGIN
  IF current_setting('app.seed_target',true) IS DISTINCT FROM 'test'
    OR current_setting('app.seed_project_ref',true) IS DISTINCT FROM '${TEST_VIDEO_PROJECT}'
    OR current_setting('app.seed_storage_verified',true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'TEST identity and Stream verification required';
  END IF;
  LOCK TABLE media_plaza.video_artifacts IN SHARE ROW EXCLUSIVE MODE;
  IF (SELECT count(*) FROM media_plaza.video_artifacts) <> 13 THEN RAISE EXCEPTION 'Asset set changed'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
    UPDATE media_plaza.video_artifacts SET stream_uid=r->>'uid',
      playback_url='https://${host}/' || (r->>'uid') || '/manifest/video.m3u8'
    WHERE id=(r->>'id')::UUID AND storage_path=r->>'path' AND byte_size=(r->>'bytes')::BIGINT
      AND (stream_uid IS NULL OR stream_uid=r->>'uid');
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'Asset compare-and-swap failed'; END IF;
  END LOOP;
END $stream$;
COMMIT;
`;
}
