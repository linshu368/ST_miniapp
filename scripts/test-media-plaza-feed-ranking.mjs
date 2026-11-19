// Local, synthetic SQL only. Pass an installed @electric-sql/pglite dist/index.js.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass a local PGlite module path');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA media_plaza; GRANT USAGE ON SCHEMA media_plaza TO anon, authenticated, service_role;
    CREATE TABLE media_plaza.image_plaza_works (
      id uuid PRIMARY KEY, user_id uuid, attempt_id uuid, artifact_id uuid, title text DEFAULT 'Synthetic',
      model_id text, model_name text DEFAULT '', width integer DEFAULT 640, height integer DEFAULT 960,
      tags text[] DEFAULT '{}', snapshot jsonb DEFAULT '{"prompt":"portrait","prompt_zh":"人像_50%"}',
      like_count integer DEFAULT 0, published_at timestamptz DEFAULT now(), deleted_at timestamptz,
      initial_feed_order bigint UNIQUE, media_type text DEFAULT 'image', video_artifact_id uuid,
      video_attempt_id uuid, duration_ms integer, description text DEFAULT '', source_heat integer
    );
  `);
  const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
  const insert = async (n, model, heat, media = 'image', likes = 0) => {
    await db.query(
      `INSERT INTO media_plaza.image_plaza_works
      (id,model_id,source_heat,media_type,like_count,initial_feed_order)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [id(n), model, heat, media, likes, n]
    );
  };
  await insert(1, 'a', 1000);
  await insert(2, 'a', 500);
  await insert(3, 'b', 10);
  await insert(4, 'b', 5);
  await insert(5, 'v', 100, 'video');
  await insert(6, 'v', 50, 'video');
  await insert(7, 'empty', null);
  await insert(8, 'a', 0);
  await insert(9, 'v', 0, 'video', 1);
  await insert(10, 'a', 1, 'image', 3);
  await db.query('UPDATE media_plaza.image_plaza_works SET model_id=NULL WHERE id=$1', [id(7)]);
  const migration = await readFile(
    'packages/shared/migrations/20261118_media_plaza_feed_ranking.sql',
    'utf8'
  );
  await db.exec(migration);
  const read = async ({ media = 'all', limit = 20, cursor, search = '', tags = [] } = {}) => {
    const result = await db.query(
      `SELECT media_plaza.read_image_plaza_recommended_feed(
      $1,$2,$3,$4,$5,$6,$7,$8,$9) AS page`,
      [
        media,
        search,
        tags,
        limit,
        cursor?.revision ?? null,
        cursor?.partition ?? null,
        cursor?.likes ?? null,
        cursor?.order ?? null,
        cursor?.id ?? null,
      ]
    );
    return result.rows[0].page;
  };
  const all = await read();
  assert.deepEqual(
    all.items.slice(0, 2).map((row) => row.id),
    [id(10), id(9)],
    'local likes dominate external heat'
  );
  assert.deepEqual(
    all.items.slice(2, 8).map((row) => row.id),
    [id(1), id(3), id(5), id(2), id(4), id(6)]
  );
  for (const media of ['image', 'video']) {
    const page = await read({ media });
    assert.deepEqual(
      page.items.map((row) => row.id),
      all.items.filter((row) => row.media_type === media).map((row) => row.id)
    );
  }
  // Static pagination crosses the liked/zero boundary, retaining exact bigint strings.
  const collected = [];
  let cursor;
  for (let attempt = 0; attempt < 20; attempt++) {
    const page = await read({ limit: 2, cursor });
    const visible = page.items.slice(0, 2);
    collected.push(...visible.map((row) => row.id));
    if (page.items.length <= 2) break;
    const last = visible.at(-1);
    cursor = {
      revision: page.ranking_revision,
      partition: last.like_count ? 'liked' : 'zero',
      likes: last.like_count || null,
      order: last.initial_feed_order,
      id: last.id,
    };
  }
  assert.deepEqual(
    collected,
    all.items.map((row) => row.id)
  );
  assert.equal(new Set(collected).size, 10);
  assert.equal((await read({ tags: ['人像_50%'] })).items.length, 10);
  assert.equal((await read({ tags: ['人像_5X'] })).items.length, 0, 'ILIKE wildcard escaping');
  assert.equal((await read({ search: 'missing' })).items.length, 0);
  const legacy = await db.query(
    'SELECT initial_feed_order::text AS value FROM media_plaza.image_plaza_works WHERE id=$1',
    [id(1)]
  );
  assert.equal(legacy.rows[0].value, '1', 'old ranking unchanged');
  await db.query('UPDATE media_plaza.image_plaza_works SET like_count=0 WHERE id=$1', [id(10)]);
  assert.equal((await read()).items[0].id, id(9));
  await insert(11, 'new-local', null);
  assert.equal((await read()).items.at(-1).id, id(11), 'new share has no recency boost');
  const rebuilt = await db.query('SELECT media_plaza.rebuild_image_plaza_feed_order() AS result');
  assert.notEqual(rebuilt.rows[0].result.ranking_revision, all.ranking_revision);
  await assert.rejects(() => read({ cursor }), /IMAGE_PLAZA_INVALID_CURSOR/);
  await assert.rejects(() => read({ limit: 21 }), /invalid_arguments/);
  // A failure after deleting the previous generation must roll back the complete rebuild.
  await db.exec(`CREATE FUNCTION media_plaza.reject_test_score() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic_rebuild_failure'; END $$;
    CREATE TRIGGER reject_test_score BEFORE INSERT ON media_plaza.image_plaza_feed_scores
    FOR EACH ROW EXECUTE FUNCTION media_plaza.reject_test_score();`);
  await assert.rejects(
    () => db.query('SELECT media_plaza.rebuild_image_plaza_feed_order()'),
    /synthetic_rebuild_failure/
  );
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM media_plaza.image_plaza_feed_scores')).rows[0]
      .n,
    11
  );
  await db.exec(`DROP TRIGGER reject_test_score ON media_plaza.image_plaza_feed_scores;
    DROP FUNCTION media_plaza.reject_test_score();`);
  const acl = await db.query(`SELECT
    has_table_privilege('anon','media_plaza.image_plaza_feed_scores','SELECT') AS anon_read,
    has_function_privilege('authenticated','media_plaza.rebuild_image_plaza_feed_order()','EXECUTE') AS auth_write,
    has_function_privilege('service_role','media_plaza.rebuild_image_plaza_feed_order()','EXECUTE') AS service_write`);
  assert.deepEqual(acl.rows[0], { anon_read: false, auth_write: false, service_write: true });
  await db.exec('SET ROLE service_role');
  assert.equal((await read()).items.length, 11);
  await db.exec('RESET ROLE');
  // Synthetic upper bound; local engine timings are not production API P95.
  await db.exec(`INSERT INTO media_plaza.image_plaza_works(id,model_id,source_heat,media_type)
    SELECT ('22222222-2222-4222-8222-' || lpad(n::text,12,'0'))::uuid,
      'model-' || (n % 12), n % 1000, CASE WHEN n % 3=0 THEN 'video' ELSE 'image' END
    FROM generate_series(1,99989) n`);
  const started = performance.now();
  assert.equal(
    (await db.query('SELECT media_plaza.rebuild_image_plaza_feed_order() AS r')).rows[0].r.count,
    100000
  );
  const rebuildMs = Math.round(performance.now() - started);
  const reads = [];
  for (let n = 0; n < 10; n++) {
    const at = performance.now();
    assert.equal((await read({ media: n % 2 ? 'video' : 'all' })).items.length, 21);
    reads.push(Math.round(performance.now() - at));
  }
  // EXPLAIN the actual RPC page SQL with fixed synthetic first-page parameters.
  let pageSql = migration
    .slice(
      migration.indexOf('WITH filtered AS NOT MATERIALIZED'),
      migration.indexOf("  RETURN jsonb_build_object('ranking_revision', v_revision, 'items'")
    )
    .replace('INTO v_items FROM page', 'FROM page');
  const literals = {
    p_media: "'all'",
    p_search: "''",
    p_tag_labels: 'ARRAY[]::text[]',
    p_limit: '20',
    p_partition: 'NULL::text',
    p_like_count: 'NULL::integer',
    p_order: 'NULL::bigint',
    p_id: 'NULL::uuid',
    v_pattern: "'%'",
  };
  for (const [name, value] of Object.entries(literals))
    pageSql = pageSql.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
  const explained = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${pageSql}`)).rows[0][
    'QUERY PLAN'
  ][0];
  const planNodes = [];
  const walk = (plan) => {
    planNodes.push({
      node: plan['Node Type'],
      index: plan['Index Name'],
      rows: plan['Actual Rows'],
    });
    (plan.Plans ?? []).forEach(walk);
  };
  walk(explained.Plan);
  assert.ok(
    planNodes.some((node) => node.index?.includes('initial_feed_order') && node.rows <= 21),
    'first page must stop the ranking index scan at the page boundary'
  );
  await insert(12, 'overflow', 1);
  await assert.rejects(
    () => db.query('SELECT media_plaza.rebuild_image_plaza_feed_order()'),
    /capacity_exceeded/
  );
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM media_plaza.image_plaza_feed_scores')).rows[0]
      .n,
    100000
  );
  await db.exec('DELETE FROM media_plaza.image_plaza_works');
  assert.equal((await read()).items.length, 0);
  const emptyRebuild = (await db.query('SELECT media_plaza.rebuild_image_plaza_feed_order() AS r'))
    .rows[0].r;
  assert.equal(emptyRebuild.count, 0);
  assert.equal(emptyRebuild.ranking_revision, '00000000-0000-0000-0000-000000000000');
  assert.equal((await read()).ranking_revision, emptyRebuild.ranking_revision);
  console.log(
    JSON.stringify({
      result: 'passed',
      syntheticRows: 100000,
      rebuildMs,
      readMs: reads,
      planNodes,
      limitation: 'single-connection local engine; not concurrent lock or production P95 evidence',
    })
  );
} finally {
  await db.close();
}
