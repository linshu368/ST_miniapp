import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll } from 'vitest';
import { CreatorAnalyticsQuerySchema, type CreatorAnalyticsQuery } from '@miniapp/shared';
import { buildCreatorAnalyticsQuery } from './analytics-query.js';

const container = process.env.CREATOR_ANALYTICS_TEST_CONTAINER;
const database = process.env.CREATOR_ANALYTICS_TEST_DB;
const id = (n: number) => `75000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1);
const fixed = new Date('2026-11-02T12:00:00Z');
const migration = readFileSync(
  new URL('../../../../shared/migrations/20261030_character_creator_rewards.sql', import.meta.url),
  'utf8'
);
const rewardDDL = migration.slice(
  migration.indexOf('CREATE TABLE IF NOT EXISTS billing.character_creator_reward_balances'),
  migration.indexOf('-- The accepted owner/rule')
);
const literal = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value instanceof Date) return literal(value.toISOString());
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
  throw new Error('Unsupported fixture parameter');
};
const fixture = `
CREATE SCHEMA IF NOT EXISTS billing;
${rewardDDL}
INSERT INTO app_core.users(id) SELECT ('75000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,5)n;
INSERT INTO app_core.characters(id,name) SELECT ('75000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'角色'||n FROM generate_series(11,16)n;
INSERT INTO app_core.character_creations(character_id,owner_user_id,draft,draft_runtime,state,visibility,created_at)
 SELECT ('75000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 CASE WHEN n=16 THEN '${id(2)}'::uuid ELSE '${owner}'::uuid END,'{}','{}','ready',CASE WHEN n=11 THEN 'private' ELSE 'public' END,'2026-09-01Z' FROM generate_series(11,16)n;
UPDATE app_core.character_creations SET published_revision=1,approved_revision=1 WHERE owner_user_id IN ('${owner}','${id(2)}');
INSERT INTO app_core.character_access_grants(user_id,character_id) VALUES ('${id(3)}','${id(11)}'),('${id(4)}','${id(11)}');
INSERT INTO experience.chat_sessions(id,user_id,character_id) VALUES
 ('${id(21)}','${id(3)}','${id(11)}'),('${id(22)}','${id(3)}','${id(12)}'),
 ('${id(23)}','${id(4)}','${id(11)}'),('${id(24)}','${id(4)}','${id(12)}'),
 ('${id(25)}','${owner}','${id(11)}'),('${id(26)}','${id(5)}','${id(16)}');
INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,status,session_id,turn_index,revision,created_at)
 SELECT '${id(3)}','fixture','synthetic','synthetic','${id(11)}','success','${id(21)}',n,1,
 CASE WHEN n<=6 THEN '2026-11-01T15:00:00Z'::timestamptz ELSE '2026-11-01T17:00:00Z'::timestamptz END FROM generate_series(1,12)n;
INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,status,session_id,turn_index,revision,created_at)
 SELECT s.user_id,'fixture','synthetic','synthetic',s.character_id,'success',s.id,n,1,'2026-11-01T15:00:00Z'
 FROM experience.chat_sessions s CROSS JOIN generate_series(1,5)n WHERE s.id IN('${id(22)}','${id(23)}','${id(24)}','${id(25)}','${id(26)}');
-- A successful old turn followed by new successful and failed regenerations stays one old turn.
INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,status,session_id,turn_index,revision,created_at) VALUES
 ('${id(3)}','fixture','synthetic','synthetic','${id(11)}','success','${id(21)}',13,1,'2026-10-01Z'),
 ('${id(3)}','fixture','synthetic','synthetic','${id(11)}','success','${id(21)}',13,2,'2026-11-02T01:00:00Z'),
 ('${id(3)}','fixture','synthetic','','${id(11)}','failed','${id(21)}',13,3,'2026-11-02T02:00:00Z');
-- Inherited messages and a regenerated inherited reply are not new logical turns.
INSERT INTO experience.chat_sessions(id,user_id,character_id,branch_inherited_turns,branch_source_session_id,branch_source_turn_index,branch_source_message_id,branch_request_id)
 SELECT '${id(27)}','${id(3)}','${id(11)}',10,'${id(21)}',10,id,'${id(28)}' FROM experience.chat_history WHERE session_id='${id(21)}' AND turn_index=10;
INSERT INTO experience.chat_branch_turns SELECT '${id(27)}',turn_index,id FROM experience.chat_history WHERE session_id='${id(21)}' AND turn_index<=10;
INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,character_id,status,session_id,turn_index,revision,created_at) VALUES
 ('${id(3)}','fixture','synthetic','synthetic','${id(11)}','success','${id(27)}',10,1,'2026-11-02T01:00:00Z'),
 ('${id(3)}','fixture','synthetic','synthetic','${id(11)}','success','${id(27)}',11,1,'2026-11-02T01:00:00Z');
INSERT INTO billing.character_creator_rewards(charge_key,character_id,creator_user_id,payer_user_id,charged_amount,reward_rate,reward_amount,credited_amount,debt_offset_amount,reversal_recovered_amount,reversal_debt_amount,reversed_at,created_at) VALUES
 ('${id(31)}','${id(11)}','${owner}','${id(3)}',100,.4,40,40,0,30,10,'2026-11-02T00:00:00Z','2026-10-01Z'),
 ('${id(32)}','${id(12)}','${owner}','${id(3)}',20,.4,8,0,8,0,0,NULL,'2026-11-02T01:00:00Z'),
 ('${id(33)}','${id(12)}','${owner}','${id(3)}',10,.4,4,2,2,0,0,NULL,'2026-11-02T02:00:00Z'),
 ('${id(34)}','${id(12)}','${owner}','${id(4)}',10,.4,4,4,0,0,0,NULL,'2026-11-01Z'),
 ('${id(35)}','${id(16)}','${id(2)}','${id(5)}',1000,.4,400,400,0,0,0,NULL,'2026-11-01Z');
INSERT INTO miniapp_features.character_likes(character_id,user_id) VALUES('${id(11)}','${owner}'),('${id(11)}','${id(3)}');
INSERT INTO miniapp_features.character_favorites(character_id,user_id) VALUES('${id(11)}','${owner}'),('${id(11)}','${id(4)}');
INSERT INTO experience.chat_message_likes(session_id,message_id) SELECT session_id,id FROM experience.chat_history WHERE session_id IN('${id(21)}','${id(25)}') AND turn_index=1;
INSERT INTO miniapp_features.character_comments(id,character_id,user_id,body,created_at)
 SELECT ('75000000-0000-4000-8000-'||lpad((50+n)::text,12,'0'))::uuid,'${id(11)}','${id(3)}','public fixture '||n,'2026-11-01Z' FROM generate_series(1,6)n;
UPDATE miniapp_features.character_comments SET deleted_at=now() WHERE id='${id(56)}';
INSERT INTO miniapp_features.character_comments(id,character_id,user_id,body,created_at) VALUES('${id(57)}','${id(11)}','${owner}','owner excluded','2026-11-01Z');
`;
function query(input: Partial<CreatorAnalyticsQuery>, ownerId = owner) {
  const q = buildCreatorAnalyticsQuery(ownerId, CreatorAnalyticsQuerySchema.parse(input), fixed);
  const sql = `BEGIN; SET LOCAL statement_timeout='6s'; ${fixture}
    UPDATE app_core.characters SET enabled=false WHERE id='${id(11)}';
    UPDATE experience.chat_sessions SET deleted_at=now() WHERE id='${id(21)}';
    PREPARE analytics AS SELECT row_to_json(r) FROM (${q.text}) r;
    EXECUTE analytics(${q.values.map(literal).join(',')}); ROLLBACK;`;
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-X',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      database!,
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8', timeout: 20_000 }
  );
  return JSON.parse(output.trim()) as { allowed: boolean; data: Record<string, unknown> };
}
describe.skipIf(!container || !database)('creator analytics real isolated PostgreSQL', () => {
  beforeAll(() => {
    if (!/^creator_core_test_[a-z0-9_]+$/.test(database!))
      throw new Error('Isolated creator fixture DB required');
    expect(
      execFileSync('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', container!], {
        encoding: 'utf8',
      }).trim()
    ).toBe('none');
  });
  it('deduplicates players, revisions and branches; excludes self and foreign creator', () => {
    const result = query({});
    expect(result.allowed).toBe(true);
    expect(result.data.summary).toMatchObject({
      players: 2,
      rounds: 29,
      deepPlayers: 1,
      returningPlayers: 1,
      earned: 16,
      todayEarned: -28,
      likes: 2,
      favorites: 1,
      comments: 5,
    });
    expect(result.data.works_total).toBe(5);
    expect(result.data.works).toHaveLength(3);
    expect(result.data.rewards).toHaveLength(3);
    expect(result.data.feedback).toHaveLength(3);
  });
  it('period uses first success, Beijing days and refund date; debt offsets are not credits', () => {
    expect(query({ period: '7d' }).data.summary).toMatchObject({
      players: 2,
      rounds: 28,
      earned: -24,
      todayEarned: -28,
      deepPlayers: 1,
      returningPlayers: 1,
    });
    expect(query({ period: '7d', character_id: id(11) }).data.summary).toMatchObject({
      rounds: 18,
      earned: -30,
    });
  });
  it('owner-only scope does not leak a foreign or nonexistent card', () => {
    expect(query({ character_id: id(16) }).allowed).toBe(false);
    expect(query({ character_id: id(99) }).allowed).toBe(false);
    expect(query({}, id(2)).data.summary).toMatchObject({ players: 1, rounds: 5, earned: 400 });
  });
  it('all lists page on the server with stable ordering, including tied timestamps', () => {
    for (const section of ['works', 'characters', 'feedback', 'rewards'] as const) {
      const first = query({ section, page_size: 3 }).data;
      const second = query({ section, page: 2, page_size: 3 }).data;
      const items = first.items as Array<{ id: string }>;
      const next = second.items as Array<{ id: string }>;
      expect(items).toHaveLength(3);
      expect(next.length).toBeGreaterThan(0);
      expect(new Set([...items, ...next].map((x) => x.id)).size).toBe(items.length + next.length);
      expect(query({ section, page: 99, page_size: 3 }).data.items).toEqual([]);
    }
  });
  it('zero is returned only for a real empty scope', () => {
    const result = query({}, id(5));
    expect(result.data.card_count).toBe(0);
    expect(result.data.summary).toMatchObject({ players: 0, rounds: 0, earned: 0 });
    expect(result.data.works).toEqual([]);
  });
});
