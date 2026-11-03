import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPublicCreatorPageQuery,
  PUBLIC_CREATOR_PAGE_SIZE,
  type PublicAuthorPageRow,
} from './public-author.js';

const container = process.env.CREATOR_ANALYTICS_TEST_CONTAINER;
const database = process.env.CREATOR_ANALYTICS_TEST_DB;
const id = (n: number) => '77000000-0000-4000-8000-' + String(n).padStart(12, '0');
const alias = (owner: string) =>
  createHash('md5')
    .update('st-public-creator-v1:' + owner)
    .digest('hex')
    .replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
const owner = id(101);
const other = id(102);
const allPrivate = id(103);
const fixture = `
INSERT INTO app_core.users(id) VALUES ('${owner}'),('${other}'),('${allPrivate}');
INSERT INTO app_core.miniapp_user_settings(user_id,display_name) VALUES ('${owner}','同名作者'),('${other}','同名作者');
INSERT INTO app_core.characters(id,name,description,enabled,archived_at,is_test,last_listed_at,created_at)
 SELECT ('77000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'公开版本'||n,repeat('长',200),n<>17,
 CASE WHEN n=16 THEN now() ELSE NULL END,n=20,'2026-10-01Z','2026-09-01Z' FROM generate_series(1,23)n;
INSERT INTO app_core.character_creations(character_id,owner_user_id,draft,draft_runtime,state,visibility,approved_revision,review_status)
 SELECT ('77000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 (CASE n WHEN 22 THEN '${other}' WHEN 23 THEN '${allPrivate}' ELSE '${owner}' END)::uuid,
 '{"name":"未发布新草稿"}','{}',CASE WHEN n=19 THEN 'draft' ELSE 'ready' END,
 CASE WHEN n IN (15,23) THEN 'private' ELSE 'public' END,CASE WHEN n IN (18,19) THEN NULL ELSE 1 END,
 CASE WHEN n=14 THEN 'rejected' ELSE 'not_submitted' END
 FROM generate_series(1,23)n WHERE n<>21;
UPDATE app_core.character_creations SET published_revision=1 WHERE character_id='${id(14)}';
-- On card 14 the same user likes the card and two different replies, and two users favorite it.
INSERT INTO miniapp_features.character_likes(character_id,user_id) VALUES ('${id(14)}','${other}'),('${id(15)}','${other}');
INSERT INTO miniapp_features.character_favorites(character_id,user_id) VALUES ('${id(14)}','${other}'),('${id(14)}','${allPrivate}'),('${id(15)}','${other}');
INSERT INTO experience.chat_sessions(id,user_id,character_id) VALUES ('${id(201)}','${other}','${id(14)}');
INSERT INTO experience.chat_history(id,user_id,character_id,session_id,model,user_input,assistant_reply,turn_index,revision)
 VALUES ('${id(211)}','${other}','${id(14)}','${id(201)}','model','q','a',1,1),
        ('${id(212)}','${other}','${id(14)}','${id(201)}','model','q','a',2,1);
INSERT INTO experience.chat_message_likes(session_id,message_id) VALUES ('${id(201)}','${id(211)}'),('${id(201)}','${id(212)}');
INSERT INTO app_core.character_access_grants(user_id,character_id) VALUES ('${other}','${id(15)}');
`;

describe.skipIf(!container || !database)('public author space on isolated PostgreSQL', () => {
  it('uses only current public snapshots, separates same-name creators, and paginates equal timestamps', () => {
    if (
      !/^creator_core_test_[a-z0-9_]+$/.test(database!) ||
      execFileSync('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', container!], {
        encoding: 'utf8',
      }).trim() !== 'none'
    )
      throw new Error('Isolated creator fixture DB required');
    const query = buildPublicCreatorPageQuery(alias(owner), 1);
    const sql = `BEGIN; SET LOCAL statement_timeout='6s'; ${fixture}
      PREPARE space AS SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (${query.text}) r;
      EXECUTE space('${alias(owner)}',13,0,12,12); EXECUTE space('${alias(owner)}',13,12,12,12);
      EXECUTE space('${alias(other)}',13,0,12,12); EXECUTE space('${alias(allPrivate)}',13,0,12,12);
      UPDATE app_core.character_creations SET visibility='private' WHERE character_id='${id(14)}';
      EXECUTE space('${alias(owner)}',13,0,12,12);
      UPDATE app_core.character_creations SET visibility='private' WHERE owner_user_id='${owner}';
      EXECUTE space('${alias(owner)}',13,0,12,12);
      EXECUTE space('${alias(other)}',13,12,12,12); ROLLBACK;`;
    expect(query.values).toEqual([
      alias(owner),
      PUBLIC_CREATOR_PAGE_SIZE + 1,
      0,
      PUBLIC_CREATOR_PAGE_SIZE,
      PUBLIC_CREATOR_PAGE_SIZE,
    ]);
    const pages = execFileSync(
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
      {
        input: sql,
        encoding: 'utf8',
        timeout: 20_000,
      }
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as PublicAuthorPageRow[]);
    const cards = (page: number) => pages[page]![0]!.cards;
    expect(cards(0)).toHaveLength(PUBLIC_CREATOR_PAGE_SIZE);
    expect(pages[0]![0]!.has_more).toBe(true);
    expect(pages[1]![0]!.has_more).toBe(false);
    expect(cards(0)[0]).toMatchObject({ like_count: 3, favorite_count: 2 });
    expect(cards(0)[1]).toMatchObject({ like_count: 0, favorite_count: 0 });
    expect([...cards(0).slice(0, 12), ...cards(1)].map((card) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, i) => id(14 - i))
    );
    expect(cards(0)[0]?.description).toBe('长'.repeat(120));
    expect(cards(0)[0]?.name).toBe('公开版本14');
    expect(pages[0]![0]!.display_name).toBe(pages[2]![0]!.display_name);
    expect(cards(2).map((card) => card.id)).toEqual([id(22)]);
    expect(pages[3]).toEqual([]);
    expect(cards(4)[0]?.id).toBe(id(13));
    expect(pages[5]).toEqual([]);
    expect(pages[6]![0]).toMatchObject({ has_more: false, cards: [] });
  });
});
