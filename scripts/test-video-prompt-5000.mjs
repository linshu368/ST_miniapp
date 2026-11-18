// Synthetic PostgreSQL boundary/DDL regression only. No credentials or remote writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass a local PGlite module path');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const migration = await readFile(
  'packages/shared/migrations/20261118_media_plaza_message_prompt_5000.sql',
  'utf8'
);
const postflight = await readFile(
  'packages/shared/migrations/tests/20261118_media_plaza_message_prompt_5000.sql',
  'utf8'
);
const insert = (length) =>
  db.query('INSERT INTO media_plaza.image_plaza_messages(content) VALUES ($1)', [
    '长'.repeat(length),
  ]);
try {
  await db.exec(`CREATE ROLE service_role; CREATE ROLE anon;
    CREATE SCHEMA media_plaza;
    CREATE TABLE media_plaza.image_plaza_messages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, content text NOT NULL,
      CONSTRAINT image_plaza_messages_content_check CHECK (char_length(trim(content)) >= 1 AND char_length(trim(content)) <= 2000)
    );
    ALTER TABLE media_plaza.image_plaza_messages ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA media_plaza TO service_role;
    GRANT INSERT,SELECT ON media_plaza.image_plaza_messages TO service_role;`);
  await insert(2000);
  await assert.rejects(() => insert(2001), { code: '23514' });
  const structure = async () =>
    (
      await db.query(`SELECT relacl::text,relrowsecurity,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=c.oid AND contype='p') AS pk
    FROM pg_class c WHERE c.oid='media_plaza.image_plaza_messages'::regclass`)
    ).rows[0];
  const before = await structure();
  await db.exec(migration);
  await db.exec(postflight);
  await db.exec(migration);
  await db.exec(postflight);
  assert.deepEqual(await structure(), before);
  for (const length of [2001, 5000]) await insert(length);
  for (const length of [0, 5001]) await assert.rejects(() => insert(length), { code: '23514' });
  assert.deepEqual(
    (
      await db.query(
        'SELECT char_length(content) AS n FROM media_plaza.image_plaza_messages ORDER BY id'
      )
    ).rows.map((row) => row.n),
    [2000, 2001, 5000]
  );
  assert.equal(
    (
      await db.query(
        "SELECT has_table_privilege('anon','media_plaza.image_plaza_messages','SELECT') AS allowed"
      )
    ).rows[0].allowed,
    false
  );
  // Unknown CHECK shape must fail without replacing the authoritative constraint.
  await db.exec(`ALTER TABLE media_plaza.image_plaza_messages DROP CONSTRAINT image_plaza_messages_content_check;
    ALTER TABLE media_plaza.image_plaza_messages ADD CONSTRAINT image_plaza_messages_content_check CHECK (char_length(trim(content)) BETWEEN 1 AND 6000)`);
  await assert.rejects(() => db.exec(migration), /unexpected content constraint/);
  await db.exec('ROLLBACK');
  await insert(6000);
  await assert.rejects(() => insert(6001), { code: '23514' });
  console.log(
    'PASS: 2000/2001/5000/5001, complete content, nonempty, replay, unknown-shape rollback, RLS/ACL/PK preservation'
  );
} finally {
  await db.close();
}
