import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFeaturedCatalog, readRecommendationCatalog } from './catalog-read.js';
import { readLobbyHeadRows } from './head-read.js';

// Explicit local-only opt-in. Never import app config, dotenv or any remote connection string.
describe.skipIf(process.env.ST_LOBBY_PG_PORT !== '55439')(
  'catalog SQL on disposable local PG17',
  () => {
    const name = `st_catalog_${randomUUID().replaceAll('-', '')}`;
    const connection = {
      host: '127.0.0.1',
      port: 55439,
      user: 'postgres',
      connectionTimeoutMillis: 3000,
    };
    const admin = new Client({ ...connection, database: 'postgres' });
    let client: Client | undefined;
    const cardId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const db = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        const query = Prisma.sql(strings, ...values);
        return (await client!.query(query.text, [...query.values])).rows;
      },
    } as unknown as Pick<PrismaClient, '$queryRaw'>;

    beforeAll(async () => {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      client = new Client({ ...connection, database: name, statement_timeout: 10000 });
      await client.connect();
      await client.query(`CREATE SCHEMA app_core;
      CREATE TABLE app_core.characters(id uuid PRIMARY KEY,name text NOT NULL,description text NOT NULL,
        avatar_url text NOT NULL DEFAULT '',tags text[] NOT NULL DEFAULT '{}',creator text NOT NULL DEFAULT '',
        sort_order integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),enabled boolean NOT NULL DEFAULT true,
        is_test boolean NOT NULL DEFAULT false,archived_at timestamptz);
      CREATE TABLE app_core.character_creations(character_id uuid PRIMARY KEY,state text,visibility text,approved_revision integer);
      INSERT INTO app_core.characters(id,name,description,tags,sort_order)
      SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic',repeat('complete ',1000),
        ARRAY['one','two','three'],n FROM generate_series(1,14) n;
      INSERT INTO app_core.character_creations VALUES('10000000-0000-4000-8000-000000000001','ready','private',1);`);
      const migration = readFileSync(
        new URL('../../../../shared/migrations/20261030_creator_characters.sql', import.meta.url),
        'utf8'
      );
      const start = migration.indexOf('CREATE FUNCTION app_core.can_discover_character(');
      const end = migration.indexOf('$$;', start) + 3;
      if (start < 0 || end < start) throw new Error('Authoritative visibility function missing');
      await client.query(migration.slice(start, end));
    });

    afterAll(async () => {
      await client?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });

    it('revalidates exact fields/order/privacy, fills hidden slots and retains full descriptions', async () => {
      const first = await readRecommendationCatalog(db, null);
      expect(first.value.map((c) => c.id)).toEqual(
        Array.from({ length: 13 }, (_, i) => cardId(i + 2))
      );
      expect(await readRecommendationCatalog(db, first)).toBe(first);
      const featured = await readFeaturedCatalog(db, null);
      expect(await readFeaturedCatalog(db, featured)).toBe(featured);
      const ids = Array.from({ length: 14 }, (_, i) => cardId(i + 1));
      const heads = await readLobbyHeadRows(db, ids);
      expect(heads.map((c) => c.id)).toEqual(ids.slice(1, 13));
      expect(heads[0]?.description).toBe('complete '.repeat(1000));
      expect(await readLobbyHeadRows(db, ids)).toEqual(heads);

      // There is deliberately no updated_at column: invalidation must follow actual fields.
      await client!.query(
        `UPDATE app_core.characters SET tags=ARRAY['changed'],description='  ',sort_order=-1 WHERE id=$1`,
        [cardId(3)]
      );
      const changed = await readRecommendationCatalog(db, first);
      expect(changed.fingerprint).not.toBe(first.fingerprint);
      expect(changed.value[0]).toEqual({ id: cardId(3), tags: ['changed'], canExplore: false });
      expect((await readFeaturedCatalog(db, featured)).value[0]?.id).toBe(cardId(3));
      expect((await readLobbyHeadRows(db, ids)).find((c) => c.id === cardId(3))?.description).toBe(
        '  '
      );

      await client!.query(
        `UPDATE app_core.character_creations SET visibility='public' WHERE character_id=$1`,
        [cardId(1)]
      );
      expect((await readLobbyHeadRows(db, ids))[0]?.id).toBe(cardId(1));
      await client!.query('UPDATE app_core.characters SET enabled=false WHERE id=$1', [cardId(2)]);
      expect((await readLobbyHeadRows(db, ids)).some((c) => c.id === cardId(2))).toBe(false);
      expect(
        (await readRecommendationCatalog(db, changed)).value.some((c) => c.id === cardId(2))
      ).toBe(false);

      await client!.query(`INSERT INTO app_core.characters(id,name,description,sort_order)
      SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic','complete',n
      FROM generate_series(15,10015) n`);
      expect((await readRecommendationCatalog(db, null)).value).toHaveLength(10000);
      expect((await readFeaturedCatalog(db, null)).value).toHaveLength(10014);
    }, 30000);
  }
);
