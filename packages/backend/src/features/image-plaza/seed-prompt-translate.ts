import { IMAGE_PLAZA_PROMPT_MAX_CHARS, ImagePlazaSnapshotSchema } from '@miniapp/shared';
import pg from 'pg';
import { config } from '../../platform/config.js';
import { translateImagePlazaPromptToZh } from '../generation/image-plaza-prompt-translate.js';

export interface SeedPromptTranslateRow {
  id: string;
  prompt: string;
  promptZh: string | null;
}

export type SeedPromptTranslateStatus =
  | 'translated'
  | 'skipped_existing'
  | 'failed_marked'
  | 'failed_over_limit'
  | 'failed';

let sharedPool: pg.Pool | null = null;

/** 运维脚本走 Postgres pool：并发翻译时避免单 Client 交叉查询。 */
function getPgPool(): pg.Pool {
  if (sharedPool) return sharedPool;
  const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || '';
  if (!connectionString) throw new Error('image_plaza_seed_prompt_database_url_missing');
  sharedPool = new pg.Pool({
    connectionString,
    max: 6,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 120_000,
  });
  return sharedPool;
}

export async function closeSeedPromptTranslateResources(): Promise<void> {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.end();
}

export async function countCivitaiSeedPromptTranslatePending(): Promise<{
  total: number;
  pending: number;
  translated: number;
  failed: number;
}> {
  const pool = getPgPool();
  const { rows } = await pool.query<{
    total: number;
    pending: number;
    translated: number;
    failed: number;
  }>(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE coalesce(nullif(trim(snapshot->>'prompt_zh'), ''), '') = ''
          AND coalesce(snapshot->>'prompt_zh_failed', 'false') NOT IN ('true', 't', '1')
      )::int AS pending,
      count(*) FILTER (
        WHERE coalesce(nullif(trim(snapshot->>'prompt_zh'), ''), '') <> ''
      )::int AS translated,
      count(*) FILTER (
        WHERE coalesce(snapshot->>'prompt_zh_failed', 'false') IN ('true', 't', '1')
      )::int AS failed
    FROM experience.image_plaza_works
    WHERE origin = 'civitai_seed'
      AND source_platform = 'civitai'
      AND deleted_at IS NULL
  `);
  const row = rows[0];
  if (!row) throw new Error('image_plaza_seed_prompt_count_failed');
  return row;
}

/** 默认只拉仍待译（无译文且未标记永久失败）的行，便于全量扫尾。 */
export async function listCivitaiSeedWorksForPromptTranslate(input: {
  offset: number;
  limit?: number;
  pendingOnly?: boolean;
}): Promise<SeedPromptTranslateRow[]> {
  const pool = getPgPool();
  const limit = input.limit ?? 10_000;
  const pendingOnly = input.pendingOnly !== false;
  const { rows } = await pool.query<{ id: string; snapshot: unknown }>(
    pendingOnly
      ? `
      SELECT id, snapshot
      FROM experience.image_plaza_works
      WHERE origin = 'civitai_seed'
        AND source_platform = 'civitai'
        AND deleted_at IS NULL
        AND coalesce(nullif(trim(snapshot->>'prompt_zh'), ''), '') = ''
        AND coalesce(snapshot->>'prompt_zh_failed', 'false') NOT IN ('true', 't', '1')
      ORDER BY id ASC
      OFFSET $1
      LIMIT $2
    `
      : `
      SELECT id, snapshot
      FROM experience.image_plaza_works
      WHERE origin = 'civitai_seed'
        AND source_platform = 'civitai'
        AND deleted_at IS NULL
      ORDER BY id ASC
      OFFSET $1
      LIMIT $2
    `,
    [input.offset, limit]
  );

  return rows.flatMap((row) => {
    const parsed = ImagePlazaSnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success) return [];
    const promptZh =
      typeof parsed.data.prompt_zh === 'string' && parsed.data.prompt_zh.trim().length > 0
        ? parsed.data.prompt_zh.trim()
        : null;
    return [
      {
        id: row.id,
        prompt: parsed.data.prompt,
        promptZh,
      },
    ];
  });
}

export async function translateAndStoreSeedPrompt(input: {
  workId: string;
  force: boolean;
}): Promise<SeedPromptTranslateStatus> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ id: string; snapshot: unknown }>(
    `
      SELECT id, snapshot
      FROM experience.image_plaza_works
      WHERE id = $1::uuid
        AND origin = 'civitai_seed'
        AND source_platform = 'civitai'
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [input.workId]
  );
  const data = rows[0];
  if (!data) throw new Error('image_plaza_seed_prompt_work_missing');

  const parsed = ImagePlazaSnapshotSchema.safeParse(data.snapshot);
  if (!parsed.success) throw new Error('image_plaza_seed_prompt_snapshot_invalid');

  const existing =
    typeof parsed.data.prompt_zh === 'string' && parsed.data.prompt_zh.trim().length > 0
      ? parsed.data.prompt_zh.trim()
      : null;
  if (existing && !input.force) return 'skipped_existing';
  if (parsed.data.prompt_zh_failed === true && !input.force) return 'skipped_existing';

  if (config.database.target !== 'test' && config.database.target !== 'production') {
    throw new Error('image_plaza_seed_prompt_unknown_database_target');
  }

  try {
    const translated = await translateImagePlazaPromptToZh({
      prompt: parsed.data.prompt,
    });
    const promptZh = translated.trim();
    if (!promptZh || promptZh.length > IMAGE_PLAZA_PROMPT_MAX_CHARS) {
      await markFailed(pool, input.workId, parsed.data);
      return 'failed_over_limit';
    }

    const nextSnapshot: Record<string, unknown> = { ...parsed.data, prompt_zh: promptZh };
    delete nextSnapshot.prompt_zh_failed;
    await pool.query(
      `
        UPDATE experience.image_plaza_works
        SET snapshot = $2::jsonb
        WHERE id = $1::uuid
          AND origin = 'civitai_seed'
      `,
      [input.workId, JSON.stringify(nextSnapshot)]
    );
    return 'translated';
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (
      message === 'image_plaza_translate_empty_text' ||
      message === 'image_plaza_translate_bad_response' ||
      message === 'image_plaza_translate_empty_response'
    ) {
      await markFailed(pool, input.workId, parsed.data);
      return 'failed_marked';
    }
    throw err;
  }
}

async function markFailed(
  pool: pg.Pool,
  workId: string,
  snapshot: ReturnType<typeof ImagePlazaSnapshotSchema.parse>
): Promise<void> {
  const nextSnapshot: Record<string, unknown> = { ...snapshot, prompt_zh_failed: true };
  delete nextSnapshot.prompt_zh;
  await pool.query(
    `
      UPDATE experience.image_plaza_works
      SET snapshot = $2::jsonb
      WHERE id = $1::uuid
        AND origin = 'civitai_seed'
    `,
    [workId, JSON.stringify(nextSnapshot)]
  );
}
