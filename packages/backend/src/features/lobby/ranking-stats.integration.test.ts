import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { DEFAULT_LOBBY_RANKING_PARAMS, DEFAULT_LOBBY_ROTATION_CONFIG } from '@miniapp/shared';
import { Client } from 'pg';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// This suite owns a disposable local database. Never load app configuration or a remote URL.
vi.mock('../../lib/db.js', () => ({ prisma: {} }));
vi.mock('./ranking-params.js', () => ({ resolveLobbyRankingParams: vi.fn() }));
import { resolveLobbyRankingParams } from './ranking-params.js';
import { runLobbyRankingRefresh } from '../../lib/lobby-ranking-refresh-job.js';
import {
  computeRawCardStats,
  persistRankingScores,
  type RankingDbClient,
} from './ranking-stats.js';
import { computeRankingScores } from './ranking-score.js';
import {
  updateRecommendation,
  readLobbyHeadRows,
  readReusableRecommendation,
  recordRecommendationExposures,
  type RecommendationDatabase,
  type RecommendationDbClient,
} from './recommendation-repository.js';

const container = `st-lobby-score-${process.pid}-${randomUUID().slice(0, 8)}`;
let client: Client;
let now: number;
let lastQuery: Prisma.Sql;
let databasePort: number;
const migration = () =>
  readFileSync(
    new URL('../../../../shared/migrations/20261102_lobby_quality_rotation.sql', import.meta.url),
    'utf8'
  );
const cardA = '10000000-0000-4000-8000-000000000001';
const cardB = '10000000-0000-4000-8000-000000000002';
const cardC = '10000000-0000-4000-8000-000000000003';
const hour = 60 * 60 * 1000;
const params = DEFAULT_LOBBY_RANKING_PARAMS;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
}

function sqlOf(query: TemplateStringsArray | Prisma.Sql, values: readonly unknown[]): Prisma.Sql {
  return Array.isArray(query)
    ? Prisma.sql(query as TemplateStringsArray, ...values)
    : (query as Prisma.Sql);
}

// Execute the production tagged SQL, with its actual bindings, rather than a second implementation.
const db = {
  async $queryRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) {
    lastQuery = sqlOf(query, values);
    return (await client.query(lastQuery.text, [...lastQuery.values])).rows;
  },
  async $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) {
    const sql = sqlOf(query, values);
    return (await client.query(sql.text, [...sql.values])).rowCount ?? 0;
  },
} as unknown as RankingDbClient;

interface Turn {
  user: string;
  card?: string;
  at: number;
  session?: string | null;
  turn?: number | null;
  revision?: number;
  status?: string;
  input?: string;
  reply?: string | null;
  settledAt?: number | null;
}

async function turn(input: Turn): Promise<void> {
  await client.query(
    `INSERT INTO experience.chat_history
      (id,user_id,character_id,session_id,turn_index,revision,created_at,status,user_input,assistant_reply,llm_billing_settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      randomUUID(),
      input.user,
      input.card ?? cardB,
      input.session === undefined ? randomUUID() : input.session,
      input.turn === undefined ? 1 : input.turn,
      input.revision ?? 0,
      new Date(input.at),
      input.status ?? 'success',
      input.input ?? 'synthetic question',
      input.reply === undefined ? 'synthetic answer' : input.reply,
      input.settledAt == null ? null : new Date(input.settledAt),
    ]
  );
}

async function experienced(user: string, firstAt: number, count = 10): Promise<void> {
  const session = randomUUID();
  for (let index = 0; index < count; index += 1) {
    await turn({ user, card: cardA, session, turn: index + 1, at: firstAt + index * 60_000 });
  }
}

async function stats(card = cardB, overrides: Partial<typeof params> = {}) {
  const result = (await computeRawCardStats(db, { ...params, ...overrides })).find(
    (row) => row.characterId === card
  );
  expect(result).toBeDefined();
  return result!;
}

beforeAll(async () => {
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:17'
  );
  const port = Number(docker('port', container, '5432/tcp').split(':').at(-1));
  databasePort = port;
  if (!Number.isInteger(port) || port <= 0) throw new Error('No local test port');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      connectionTimeoutMillis: 1000,
    });
    try {
      await candidate.connect();
      client = candidate;
      break;
    } catch {
      await candidate.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!client) throw new Error('Disposable Postgres did not become ready');
  await client.query(`
    CREATE SCHEMA experience;
    CREATE SCHEMA app_core;
    CREATE SCHEMA miniapp_features;
    CREATE SCHEMA admin;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE config_reader NOLOGIN;
    CREATE TABLE app_core.users(id uuid PRIMARY KEY);
    CREATE TABLE app_core.characters(id uuid PRIMARY KEY);
    CREATE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        IF p_config_key = 'prior_guard' THEN RAISE EXCEPTION 'prior validator retained'; END IF;
      END $$;
    REVOKE ALL ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) TO config_reader WITH GRANT OPTION;
    CREATE TABLE experience.chat_history(
      id uuid PRIMARY KEY, user_id uuid NOT NULL, character_id uuid,
      session_id uuid, turn_index integer, revision integer,
      created_at timestamptz NOT NULL, status text NOT NULL,
      user_input text NOT NULL, assistant_reply text, llm_billing_settled_at timestamptz
    );
    CREATE INDEX ON experience.chat_history(user_id,created_at);
    CREATE INDEX ON experience.chat_history(character_id,created_at);
    CREATE INDEX ON experience.chat_history(session_id,turn_index,revision);
    CREATE TABLE miniapp_features.character_ranking_scores(
      character_id uuid PRIMARY KEY REFERENCES app_core.characters,
      n_c integer, d30_raw double precision, d30_shrunk double precision,
      k_c integer, r48_raw double precision, score numeric,
      window_days integer,min_users integer,computed_at timestamptz
    );
  `);
  const checkpointSql = readFileSync(
    new URL(
      '../../../../shared/migrations/20261104_lobby_ranking_refresh_state.sql',
      import.meta.url
    ),
    'utf8'
  );
  await client.query(checkpointSql);
  await client.query(checkpointSql);
  await client.query(migration());
  await client.query(migration()); // Idempotent replay must preserve the delegated validator and empty evidence.
  const existing = (
    await client.query<{ definition: string }>(
      `SELECT pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure) AS definition`
    )
  ).rows[0]!.definition;
  const withLaterGuard = existing.replace(
    /BEGIN\s*\n/,
    "BEGIN\n IF p_config_key = 'later_guard' THEN RAISE EXCEPTION 'later validator retained'; END IF;\n"
  );
  if (withLaterGuard === existing)
    throw new Error('Cannot install synthetic later validator guard');
  await client.query(withLaterGuard);
  await client.query(migration()); // Replaying this migration cannot erase a subsequent feature's validation.
}, 60_000);

beforeEach(async () => {
  await client.query('BEGIN');
  now = (await client.query<{ now: Date }>('SELECT now()')).rows[0]!.now.getTime();
  await client.query('INSERT INTO app_core.characters VALUES ($1),($2),($3)', [
    cardA,
    cardB,
    cardC,
  ]);
});
afterEach(async () => {
  await client?.query('ROLLBACK');
});
afterAll(async () => {
  await client?.end();
  try {
    docker('rm', '-f', container);
  } catch {
    /* already removed */
  }
});

describe('评分刷新去重（本地 PG17）', () => {
  it('只有成功提交才开始24小时窗口，配置、锁竞争和事务失败走正确分支', async () => {
    const url = `postgresql://postgres@127.0.0.1:${databasePort}/postgres`;
    const seed = new Client({ connectionString: url });
    const card = randomUUID();
    const seenEvents: string[] = [];
    const log = pino(
      {},
      {
        write(line) {
          seenEvents.push(JSON.parse(line).event);
        },
      }
    );
    const run = async (expected: string) => {
      seenEvents.length = 0;
      await runLobbyRankingRefresh(log);
      expect(seenEvents).toEqual([expected]);
    };
    await seed.connect();
    vi.stubEnv('DIRECT_URL', url);
    const config = { params, version: 1, degraded: false };
    vi.mocked(resolveLobbyRankingParams).mockResolvedValue(config);
    try {
      await seed.query('INSERT INTO app_core.characters VALUES ($1)', [card]);
      await seed.query(
        `INSERT INTO experience.chat_history (id,user_id,character_id,created_at,status,user_input)
        VALUES ($1,$2,$3,now(),'failed','synthetic')`,
        [randomUUID(), randomUUID(), card]
      );
      await seed.query('SELECT pg_advisory_lock(740074)');
      await run('lobby_ranking.skipped_locked');
      await seed.query('SELECT pg_advisory_unlock(740074)');
      await run('lobby_ranking.completed');
      const computed = async () =>
        (
          await seed.query(
            'SELECT computed_at::text AS at FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
            [card]
          )
        ).rows[0].at;
      const initial = await computed();
      // A change only to recommendation presentation must not invalidate global quality.
      vi.mocked(resolveLobbyRankingParams).mockResolvedValue({
        ...config,
        version: 2,
        params: { ...params, rotation: DEFAULT_LOBBY_ROTATION_CONFIG },
      });
      await run('lobby_ranking.skipped_fresh');
      expect(await computed()).toBe(initial);
      vi.mocked(resolveLobbyRankingParams).mockResolvedValue({
        ...config,
        version: 3,
        params: { ...params, turn_cap: params.turn_cap + 1 },
      });
      // Fail *after* scores are written to make a partial commit detectable.
      await seed.query(`CREATE FUNCTION miniapp_features.fail_test_checkpoint() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic checkpoint failure'; END $$;
        CREATE TRIGGER reject_marker BEFORE INSERT OR UPDATE ON miniapp_features.lobby_ranking_refresh_state
        FOR EACH ROW EXECUTE FUNCTION miniapp_features.fail_test_checkpoint()`);
      await run('lobby_ranking.failed');
      expect(await computed()).toBe(initial);
      await seed.query(
        'DROP TRIGGER reject_marker ON miniapp_features.lobby_ranking_refresh_state'
      );
      await run('lobby_ranking.completed');
      expect(await computed()).not.toBe(initial);
      await run('lobby_ranking.skipped_fresh');
      await seed.query(
        "UPDATE miniapp_features.lobby_ranking_refresh_state SET completed_at=now()-interval '24 hours'"
      );
      await run('lobby_ranking.completed');
      if (process.env.ST_LOBBY_SCORE_BENCHMARK === '1') {
        // Compare an expired checkpoint and an immediate restart on identical data.
        await seed.query(
          `INSERT INTO experience.chat_history
          (id,user_id,character_id,created_at,status,user_input,assistant_reply)
          SELECT gen_random_uuid(), md5((n % 500)::text)::uuid, $1::uuid,
            now() - n % 96 * interval '1 hour', 'success', 'synthetic', 'synthetic'
          FROM generate_series(1,40000) n`,
          [card]
        );
        const samples = [];
        for (let i = 0; i < 5; i++) {
          await seed.query(
            "UPDATE miniapp_features.lobby_ranking_refresh_state SET completed_at=now()-interval '25 hours'"
          );
          const start = performance.now();
          await run('lobby_ranking.completed');
          const first = performance.now();
          await run('lobby_ranking.skipped_fresh');
          samples.push({
            recomputedMs: Math.round(first - start),
            reusedMs: Math.round(performance.now() - first),
          });
        }
        process.stdout.write(JSON.stringify({ fixtureTurns: 40001, samples }) + '\n');
      }
      const grants = await seed.query(`SELECT relrowsecurity AS rls,
        has_table_privilege('authenticated',oid,'SELECT') AS authed,
        has_table_privilege('anon',oid,'SELECT') AS anon FROM pg_class
        WHERE oid='miniapp_features.lobby_ranking_refresh_state'::regclass`);
      expect(grants.rows).toEqual([{ rls: true, authed: false, anon: false }]);
    } finally {
      vi.unstubAllEnvs();
      await seed.query(
        'DROP TRIGGER IF EXISTS reject_marker ON miniapp_features.lobby_ranking_refresh_state'
      );
      await seed.query('DELETE FROM miniapp_features.lobby_ranking_refresh_state');
      await seed.query(
        'DELETE FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
        [card]
      );
      await seed.query('DELETE FROM experience.chat_history WHERE character_id=$1', [card]);
      await seed.query('DELETE FROM app_core.characters WHERE id=$1', [card]);
      await seed.end();
    }
  }, 60_000);
});

describe('角色评分的平台资历门槛（本地 PG17）', () => {
  it('同时满足满24小时与10轮才入样，24小时边界可入样', async () => {
    const qualified = randomUUID();
    const tooYoung = randomUUID();
    const tooFew = randomUUID();
    const contactAt = now - hour;
    await experienced(qualified, contactAt - 24 * hour);
    await experienced(tooYoung, contactAt - 24 * hour + 1);
    await experienced(tooFew, contactAt - 48 * hour, 9);
    for (const user of [qualified, tooYoung, tooFew]) await turn({ user, at: contactAt });
    expect(await stats()).toMatchObject({
      sampleSize: 1,
      d30Raw: 1 / 30,
      returnSampleSize: 0,
      r48Raw: null,
    });
  });

  it('首触后才完成第10轮或同刻完成不能反向获得该卡资格', async () => {
    for (const offset of [0, 1]) {
      const user = randomUUID();
      await experienced(user, now - 72 * hour, 9);
      await turn({ user, at: now - 24 * hour, status: 'error', reply: null });
      await turn({ user, card: cardA, at: now - 24 * hour + offset });
      await turn({ user, at: now - hour });
    }
    expect(await stats()).toMatchObject({ sampleSize: 0, d30Raw: null, returnSampleSize: 0 });
  });

  it('新人在这张卡聊得再长，也不会用本卡表现把自己选进样本', async () => {
    const user = randomUUID();
    const session = randomUUID();
    for (let index = 0; index < 30; index += 1)
      await turn({ user, session, turn: index + 1, at: now - 72 * hour + index * hour });
    await turn({ user, at: now - hour });
    expect(await stats()).toMatchObject({ sampleSize: 0, d30Raw: null, returnSampleSize: 0 });
    await turn({ user, card: cardC, at: now - hour });
    expect(await stats(cardC)).toMatchObject({ sampleSize: 1, d30Raw: 1 / 30 });
  });

  it('失败、空白输入/回复不能凑有效轮次', async () => {
    const user = randomUUID();
    await experienced(user, now - 72 * hour, 9);
    await turn({ user, card: cardA, at: now - 60 * hour, status: 'error' });
    await turn({ user, card: cardA, at: now - 59 * hour, reply: ' \n\t ' });
    await turn({ user, card: cardA, at: now - 58 * hour, input: '\n\t' });
    await turn({ user, at: now - hour });
    expect(await stats()).toMatchObject({ sampleSize: 0, d30Raw: null });
  });

  it('重生成不凑轮数；较晚成功或结算不能借用早先失败时间', async () => {
    const repeated = randomUUID();
    const session = randomUUID();
    for (let revision = 0; revision < 12; revision += 1)
      await turn({
        user: repeated,
        card: cardA,
        session,
        turn: 1,
        revision,
        at: now - 72 * hour + revision * 1000,
      });
    await turn({ user: repeated, at: now - hour });
    for (const settled of [false, true]) {
      const user = randomUUID();
      await experienced(user, now - 72 * hour, 9);
      const ownSession = randomUUID();
      await turn({
        user,
        card: cardA,
        session: ownSession,
        at: now - 48 * hour,
        status: 'error',
        reply: null,
      });
      await turn({
        user,
        card: cardA,
        session: ownSession,
        revision: 1,
        at: now - (settled ? 47 : 1) * hour,
        settledAt: settled ? now - hour : null,
      });
      await turn({ user, at: now - 24 * hour });
    }
    expect(await stats()).toMatchObject({ sampleSize: 0, d30Raw: null });
  });

  it('平台资历取全历史；ST旧行仍可计资历；不受R48回看配置裁剪', async () => {
    const user = randomUUID();
    for (let index = 0; index < 10; index += 1)
      await turn({
        user,
        card: cardA,
        session: null,
        turn: null,
        at: now - (120 * 24 + index) * hour,
      });
    await turn({ user, at: now - hour });
    expect(await stats(cardB, { first_touch_lookback_days: 1 })).toMatchObject({
      sampleSize: 1,
      d30Raw: 1 / 30,
    });
  });

  it('合格用户D30按轮去重，R48保持观察期和30分钟会话间隔', async () => {
    const returning = randomUUID();
    const absent = randomUUID();
    const pending = randomUUID();
    for (const user of [returning, absent, pending]) await experienced(user, now - 120 * hour);
    const session = randomUUID();
    await turn({ user: returning, session, at: now - 60 * hour });
    await turn({ user: returning, session, revision: 1, at: now - 60 * hour + 1000 });
    await turn({ user: returning, at: now - 59 * hour });
    await turn({ user: absent, at: now - 60 * hour });
    await turn({ user: pending, at: now - hour });
    const value = await stats();
    expect(value.sampleSize).toBe(3);
    expect(value.d30Raw).toBeCloseTo(4 / 3 / 30);
    expect(value.returnSampleSize).toBe(2);
    expect(value.r48Raw).toBe(0.5);
  });

  it('零合格样本覆盖旧污染统计，不保留旧成熟资格', async () => {
    await client.query(
      'INSERT INTO miniapp_features.character_ranking_scores(character_id,n_c,score) VALUES ($1,100,99)',
      [cardB]
    );
    await turn({ user: randomUUID(), at: now - hour });
    const raw = await computeRawCardStats(db, params);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({
      characterId: cardB,
      sampleSize: 0,
      d30Raw: null,
      returnSampleSize: 0,
      r48Raw: null,
    });
    await persistRankingScores(db, computeRankingScores(raw, params), params);
    expect(
      (
        await client.query(
          'SELECT n_c,k_c,min_users FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
          [cardB]
        )
      ).rows[0]
    ).toEqual({ n_c: 0, k_c: 0, min_users: 20 });
  });

  it('旧记录缺turn_index按物理行计资历；同刻不同轮次不切出假回访', async () => {
    const user = randomUUID();
    const legacySession = randomUUID();
    for (let index = 0; index < 10; index += 1)
      await turn({
        user,
        card: cardA,
        session: legacySession,
        turn: null,
        at: now - 120 * hour + index * 60_000,
      });
    const session = randomUUID();
    await turn({ user, session, turn: 1, at: now - 60 * hour });
    await turn({ user, session, turn: 2, at: now - 60 * hour });
    expect(await stats()).toMatchObject({
      sampleSize: 1,
      d30Raw: 2 / 30,
      returnSampleSize: 1,
      r48Raw: 0,
    });
    await turn({ user, session, turn: 3, at: now - 60 * hour + 31 * 60_000 });
    expect(await stats()).toMatchObject({
      sampleSize: 1,
      d30Raw: 3 / 30,
      returnSampleSize: 1,
      r48Raw: 1,
    });
  });

  it.skipIf(process.env.ST_LOBBY_SCORE_BENCHMARK !== '1')(
    '40万虚构轮次执行计划，不读远端数据',
    async () => {
      await client.query(
        `INSERT INTO experience.chat_history
      (id,user_id,character_id,session_id,turn_index,revision,created_at,status,user_input,assistant_reply)
      SELECT md5('row-'||u||'-'||t)::uuid,md5('user-'||u)::uuid,
        CASE WHEN t<=10 THEN $1::uuid ELSE $2::uuid END,
        md5('session-'||u)::uuid,t,0,
        now()-interval '10 days'+CASE WHEN t<=10 THEN t*interval '1 minute' ELSE interval '2 days'+t*interval '1 minute' END,
        'success','synthetic question','synthetic answer'
      FROM generate_series(1,10000) u CROSS JOIN generate_series(1,40) t`,
        [cardA, cardB]
      );
      await client.query('ANALYZE experience.chat_history');
      expect((await stats()).sampleSize).toBe(10000);
      const plan = (
        await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${lastQuery.text}`, [
          ...lastQuery.values,
        ])
      ).rows[0]!['QUERY PLAN'][0];
      // Only aggregate performance diagnostics; fixture bodies/identities never enter the report.
      process.stdout.write(
        JSON.stringify({
          benchmarkRows: 400000,
          executionMs: plan['Execution Time'],
          planningMs: plan['Planning Time'],
          sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
          tempReadBlocks: plan.Plan['Temp Read Blocks'],
          tempWrittenBlocks: plan.Plan['Temp Written Blocks'],
        }) + '\n'
      );
    },
    90_000
  );
});

const rotationConfig = { ...DEFAULT_LOBBY_ROTATION_CONFIG, enabled: true, rollout_percent: 100 };
const recommendationDb: RecommendationDatabase = {
  $transaction: async (run) => run(db as RecommendationDbClient),
};
const fixedOrder = (ids = [cardA, cardB, cardC]) => ({
  characterIds: ids,
  headIds: ids.slice(0, 12),
  degraded: false,
});
const recommendationOptions = (at = now, ids = [cardA, cardB, cardC]) => ({
  now: new Date(at),
  config: rotationConfig,
  visibleIds: ids,
  build: () => fixedOrder(ids),
});

function postgresTransactionDatabase(): RecommendationDatabase {
  return {
    async $transaction(run) {
      const connection = new Client({
        host: '127.0.0.1',
        port: databasePort,
        user: 'postgres',
        database: 'postgres',
        connectionTimeoutMillis: 1500,
      });
      await connection.connect();
      const transaction = {
        async $queryRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) {
          const sql = sqlOf(query, values);
          return (await connection.query(sql.text, [...sql.values])).rows;
        },
        async $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) {
          const sql = sqlOf(query, values);
          return (await connection.query(sql.text, [...sql.values])).rowCount ?? 0;
        },
      } as unknown as RecommendationDbClient;
      try {
        await connection.query('BEGIN');
        const result = await run(transaction);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        await connection.end();
      }
    },
  };
}

describe('推荐批次真实PG迁移、权限和并发', () => {
  it('迁移对浏览器角色拒绝私有读写，服务端保留权限，旧validator仍生效', async () => {
    const rows = (
      await client.query(`SELECT relname,relrowsecurity FROM pg_class WHERE oid IN
      ('miniapp_features.user_lobby_recommendations'::regclass,'miniapp_features.user_character_exposures'::regclass)`)
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      const acl = (
        await client.query(
          `SELECT has_table_privilege($1,'miniapp_features.user_lobby_recommendations','SELECT') AS can_read,
        has_table_privilege($1,'miniapp_features.user_character_exposures','INSERT') AS can_write`,
          [role]
        )
      ).rows[0];
      expect(acl).toEqual({ can_read: false, can_write: false });
    }
    expect(
      (
        await client.query(
          `SELECT has_table_privilege('service_role','miniapp_features.user_lobby_recommendations','SELECT,INSERT,UPDATE') AS allowed`
        )
      ).rows[0].allowed
    ).toBe(true);
    const validatorAcl = (
      await client.query(`SELECT grantee::regrole::text AS role,is_grantable
      FROM pg_proc p,LATERAL aclexplode(p.proacl) a
      WHERE p.oid='admin.validate_managed_config_value(text,jsonb,text)'::regprocedure AND grantee='config_reader'::regrole`)
    ).rows;
    expect(validatorAcl).toEqual([{ role: 'config_reader', is_grantable: true }]);
    await client.query('SAVEPOINT validator');
    await expect(
      client.query(`SELECT admin.validate_managed_config_value('prior_guard','{}'::jsonb,NULL)`)
    ).rejects.toThrow('prior validator retained');
    await client.query('ROLLBACK TO SAVEPOINT validator');
    await expect(
      client.query(`SELECT admin.validate_managed_config_value('later_guard','{}'::jsonb,NULL)`)
    ).rejects.toThrow('later validator retained');
    await client.query('ROLLBACK TO SAVEPOINT validator');
    await expect(
      client.query(
        `SELECT admin.validate_managed_config_value('lobby_ranking_params',$1::jsonb,NULL)`,
        [JSON.stringify({ ...params, rotation: { ...rotationConfig, interval_hours: 0 } })]
      )
    ).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT validator');
    await client.query(
      `SELECT admin.validate_managed_config_value('lobby_ranking_params',$1::jsonb,NULL)`,
      [JSON.stringify({ ...params, rotation: rotationConfig })]
    );
  });

  it('只读打开复用已存批次，到期才走原事务；试聊返回可恢复上一批', async () => {
    const user = randomUUID(),
      other = randomUUID();
    await client.query('INSERT INTO app_core.users VALUES ($1),($2)', [user, other]);
    const first = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'open', request_id: randomUUID() },
      recommendationOptions()
    );
    const open = { action: 'open' as const, request_id: randomUUID() };
    const atExpiry = new Date(now + 24 * hour);
    expect((await readReusableRecommendation(db, user, open, new Date(now)))?.batch_id).toBe(
      first.batch_id
    );
    expect(await readReusableRecommendation(db, other, open, new Date(now))).toBeNull();
    expect(await readReusableRecommendation(db, user, open, atExpiry)).toBeNull();
    await updateRecommendation(recommendationDb, user, open, recommendationOptions(+atExpiry));
    const resume = {
      action: 'resume' as const,
      request_id: randomUUID(),
      expected_batch_id: first.batch_id,
    };
    expect((await readReusableRecommendation(db, user, resume, atExpiry))?.character_ids).toEqual(
      first.character_ids
    );
    expect((await readReusableRecommendation(db, user, resume, atExpiry))?.batch_id).toBe(
      first.batch_id
    );
  });

  it('首屏按批次顺序补满12张；私密、下架、未审核和测试卡连摘要也不传', async () => {
    const ids = Array.from({ length: 18 }, () => randomUUID());
    await client.query(`
      ALTER TABLE app_core.characters ADD COLUMN is_test boolean NOT NULL DEFAULT false,
        ADD COLUMN enabled boolean NOT NULL DEFAULT true, ADD COLUMN archived_at timestamptz,
        ADD COLUMN name text NOT NULL DEFAULT '', ADD COLUMN description text NOT NULL DEFAULT '',
        ADD COLUMN avatar_url text NOT NULL DEFAULT '', ADD COLUMN tags jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN creator text NOT NULL DEFAULT '';
      CREATE TABLE app_core.character_creations(character_id uuid PRIMARY KEY, state text, visibility text, approved_revision int);
    `);
    const discovery = readFileSync(
      new URL('../../../../shared/migrations/20261030_creator_characters.sql', import.meta.url),
      'utf8'
    ).match(/CREATE FUNCTION app_core\.can_discover_character[\s\S]+?\$\$;/)?.[0];
    if (!discovery) throw new Error('Missing discovery predicate');
    await client.query(discovery);
    await client.query('INSERT INTO app_core.characters(id) SELECT unnest($1::uuid[])', [ids]);
    await client.query('UPDATE app_core.characters SET is_test=true WHERE id=$1', [ids[0]]);
    await client.query('UPDATE app_core.characters SET archived_at=now() WHERE id=$1', [ids[1]]);
    await client.query(
      `INSERT INTO app_core.character_creations VALUES
      ($1,'ready','private',1),($2,'ready','public',NULL),($3,'ready','public',1)`,
      [ids[2], ids[3], ids[4]]
    );
    const visible = await readLobbyHeadRows(db, ids);
    expect(visible.map((row) => row.id)).toEqual(ids.slice(4, 16));
    expect(await readLobbyHeadRows(db, ids.slice(0, 5))).toHaveLength(1);
  });

  it('满24h仅open更新，resume保现场，CAS缺失/旧值和重复请求不额外换批', async () => {
    const user = randomUUID();
    await client.query('INSERT INTO app_core.users VALUES ($1)', [user]);
    const firstId = randomUUID();
    const first = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'open', request_id: firstId },
      recommendationOptions()
    );
    expect(Date.parse(first.expires_at!) - Date.parse(first.generated_at!)).toBe(24 * hour);
    const resume = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'resume', request_id: randomUUID(), expected_batch_id: firstId },
      recommendationOptions(now + 25 * hour)
    );
    expect(resume.batch_id).toBe(firstId);
    const tooEarly = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'open', request_id: randomUUID() },
      recommendationOptions(now + 24 * hour - 1)
    );
    expect(tooEarly.batch_id).toBe(firstId);
    const atBoundary = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'open', request_id: randomUUID() },
      recommendationOptions(now + 24 * hour)
    );
    expect(atBoundary.batch_id).not.toBe(firstId);
    for (const expected of [undefined, firstId]) {
      const stale = await updateRecommendation(
        recommendationDb,
        user,
        { action: 'refresh', request_id: randomUUID(), expected_batch_id: expected },
        recommendationOptions(now + 24 * hour)
      );
      expect(stale.batch_id).toBe(atBoundary.batch_id);
    }
    const refresh = {
      action: 'refresh' as const,
      request_id: randomUUID(),
      expected_batch_id: atBoundary.batch_id,
    };
    const next = await updateRecommendation(
      recommendationDb,
      user,
      refresh,
      recommendationOptions(now + 25 * hour)
    );
    const retried = await updateRecommendation(
      recommendationDb,
      user,
      refresh,
      recommendationOptions(now + 26 * hour)
    );
    expect(retried.batch_id).toBe(next.batch_id);
    expect(retried.generated_at).toBe(next.generated_at);
  });

  it('撤回、曝光去重和下架补位保持归属，不接受其他用户批次', async () => {
    const user = randomUUID(),
      other = randomUUID();
    await client.query('INSERT INTO app_core.users VALUES ($1),($2)', [user, other]);
    const first = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'open', request_id: randomUUID() },
      recommendationOptions()
    );
    const input = { batch_id: first.batch_id!, character_ids: [cardA, cardA] };
    expect(
      await recordRecommendationExposures(
        recommendationDb,
        user,
        input,
        [cardA, cardB, cardC],
        new Date(now)
      )
    ).toBe(1);
    expect(
      await recordRecommendationExposures(
        recommendationDb,
        other,
        input,
        [cardA, cardB, cardC],
        new Date(now + hour)
      )
    ).toBe(0);
    const next = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'refresh', request_id: randomUUID(), expected_batch_id: first.batch_id },
      recommendationOptions(now + hour)
    );
    const restored = await updateRecommendation(
      recommendationDb,
      user,
      {
        action: 'undo',
        request_id: randomUUID(),
        expected_batch_id: next.batch_id,
        restore_batch_id: first.batch_id,
      },
      recommendationOptions(now + hour + 1000)
    );
    expect(restored.batch_id).toBe(first.batch_id);
    expect(
      await recordRecommendationExposures(
        recommendationDb,
        user,
        input,
        [cardA, cardB, cardC],
        new Date(now + 2 * hour)
      )
    ).toBe(0);
    expect(
      (
        await client.query(
          'SELECT last_seen_at FROM miniapp_features.user_character_exposures WHERE user_id=$1',
          [user]
        )
      ).rows[0].last_seen_at.getTime()
    ).toBe(now);
    const removed = await updateRecommendation(
      recommendationDb,
      user,
      { action: 'resume', request_id: randomUUID(), expected_batch_id: first.batch_id },
      recommendationOptions(now + 2 * hour, [cardB, cardC])
    );
    expect(removed.character_ids).toEqual([cardB, cardC]);
    expect(
      await recordRecommendationExposures(
        recommendationDb,
        user,
        { ...input, character_ids: [cardA] },
        [cardB, cardC],
        new Date(now + 2 * hour)
      )
    ).toBe(0);
  });

  it('可信质量只来自新口径，缺样本保留历史，新低分覆盖旧高分', async () => {
    await client.query(
      'INSERT INTO miniapp_features.character_ranking_scores(character_id,n_c,score) VALUES ($1,100,99)',
      [cardA]
    );
    expect(
      (
        await client.query(
          'SELECT quality_version,trusted_score FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
          [cardA]
        )
      ).rows[0]
    ).toEqual({ quality_version: null, trusted_score: null });
    const mature = {
      characterId: cardA,
      sampleSize: 25,
      d30Raw: 20,
      d30Shrunk: 19,
      returnSampleSize: 20,
      r48Raw: 0.8,
      score: 85,
    };
    await persistRankingScores(db, [mature]);
    await persistRankingScores(db, [{ ...mature, sampleSize: 0, d30Raw: null, score: 0 }]);
    let row = (
      await client.query(
        'SELECT n_c,quality_version,trusted_score FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
        [cardA]
      )
    ).rows[0];
    expect(row.n_c).toBe(0);
    expect(Number(row.trusted_score)).toBe(85);
    expect(row.quality_version).toBe('qualified-v1');
    await persistRankingScores(db, [{ ...mature, score: 30 }]);
    row = (
      await client.query(
        'SELECT trusted_score FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
        [cardA]
      )
    ).rows[0];
    expect(Number(row.trusted_score)).toBe(30);
    await persistRankingScores(db, [{ ...mature, characterId: cardB }]);
    row = (
      await client.query(
        'SELECT n_c,trusted_score FROM miniapp_features.character_ranking_scores WHERE character_id=$1',
        [cardA]
      )
    ).rows[0];
    expect(row.n_c).toBe(0);
    expect(Number(row.trusted_score)).toBe(30);
  });

  it('独立连接同时刷新只生成一次，跨用户批次互不串用', async () => {
    const concurrent = postgresTransactionDatabase();
    const user = randomUUID(),
      other = randomUUID(),
      card = randomUUID();
    await concurrent.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO app_core.users(id) VALUES (${user}::uuid),(${other}::uuid)`;
      await tx.$executeRaw`INSERT INTO app_core.characters(id) VALUES (${card}::uuid)`;
    });
    try {
      const options = recommendationOptions(now, [card]);
      const first = await updateRecommendation(
        concurrent,
        user,
        { action: 'open', request_id: randomUUID() },
        options
      );
      let builds = 0;
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          updateRecommendation(
            concurrent,
            user,
            { action: 'refresh', request_id: randomUUID(), expected_batch_id: first.batch_id },
            {
              ...options,
              build: () => {
                builds++;
                return fixedOrder([card]);
              },
            }
          )
        )
      );
      expect(builds).toBe(1);
      expect(new Set(results.map((result) => result.batch_id)).size).toBe(1);
      expect(
        await recordRecommendationExposures(
          concurrent,
          other,
          { batch_id: results[0]!.batch_id!, character_ids: [card] },
          [card],
          new Date(now)
        )
      ).toBe(0);
    } finally {
      await concurrent.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM app_core.users WHERE id IN (${user}::uuid,${other}::uuid)`;
        await tx.$executeRaw`DELETE FROM app_core.characters WHERE id=${card}::uuid`;
      });
    }
  });
});
