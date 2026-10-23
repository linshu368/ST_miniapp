import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureProduction,
  previouslyVerified,
  retry,
  sha256,
  stageObject,
  storageClient,
} from './migrate-image-plaza-storage.mjs';

const bytes = Buffer.from('isolated-image-data');
const item = {
  path: 'image-plaza/imports/civitai/1.png',
  mime_type: 'image/png',
  byte_size: bytes.length,
};
const noSleep = async () => {};

test('verified resume accepts only matching successful receipts, never download-only receipts', () => {
  const receipt = {
    manifest_sha256: 'manifest',
    byte_size: bytes.length,
    mime_type: item.mime_type,
    sha256: sha256(bytes),
    production_verified_at: '2026-10-20T00:00:00.000Z',
    outcome: 'created',
  };
  const now = Date.parse('2026-10-21T00:00:00.000Z');
  for (const outcome of ['created', 'existing', 'reconciled']) {
    assert.equal(previouslyVerified({ ...receipt, outcome }, item, 'manifest', now), true);
  }
  assert.equal(previouslyVerified({}, item, 'manifest', now), false);
  for (const patch of [
    { manifest_sha256: 'other' },
    { byte_size: 1 },
    { mime_type: 'text/plain' },
    { sha256: 'invalid' },
    { production_verified_at: 'invalid' },
    { production_verified_at: null },
    { production_verified_at: '2026-10-22T00:00:00.000Z' },
    { outcome: 'uploaded' },
  ]) {
    assert.throws(() => previouslyVerified({ ...receipt, ...patch }, item, 'manifest', now), {
      code: 'INVALID_VERIFIED_RECEIPT',
    });
  }
});

test('missing object uploads once; existing identical object is never overwritten', async () => {
  let stored = null;
  let writes = 0;
  const client = {
    download: async () => stored,
    upload: async (_, data) => {
      stored = data;
      writes++;
      return 'created';
    },
  };
  assert.equal(await ensureProduction(client, item, bytes, noSleep), 'created');
  assert.equal(await ensureProduction(client, item, bytes, noSleep), 'existing');
  assert.equal(writes, 1);
});

test('different existing content stops without upload', async () => {
  let writes = 0;
  const client = { download: async () => Buffer.from('conflict'), upload: async () => writes++ };
  await assert.rejects(ensureProduction(client, item, bytes, noSleep), {
    code: 'PRODUCTION_CONTENT_CONFLICT',
  });
  assert.equal(writes, 0);
});

test('unknown upload outcome reconciles before another write', async () => {
  let stored = null;
  let writes = 0;
  const client = {
    download: async () => stored,
    upload: async (_, data) => {
      stored = data;
      writes++;
      throw Object.assign(new Error(), { retryable: true });
    },
  };
  assert.equal(await ensureProduction(client, item, bytes, noSleep), 'reconciled');
  assert.equal(writes, 1);
});

test('production readback mismatch stops', async () => {
  let stored = null;
  const client = {
    download: async () => stored,
    upload: async () => {
      stored = Buffer.from('wrong');
      return 'created';
    },
  };
  await assert.rejects(ensureProduction(client, item, bytes, noSleep), {
    code: 'PRODUCTION_HASH_MISMATCH',
  });
});

test('network retry bounded to three; permanent failures never retry', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw { retryable: true };
    }, noSleep)
  );
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw { retryable: false };
    }, noSleep)
  );
  assert.equal(calls, 1);
});

test('REST distinguishes missing, permission denied, throttling and invalid MIME/size', async () => {
  const client = (response) => storageClient('https://unused.invalid', '', async () => response);
  assert.equal(
    await client(new Response(JSON.stringify({ statusCode: '404' }), { status: 400 })).download(
      item,
      true
    ),
    null
  );
  await assert.rejects(client(new Response('{}', { status: 403 })).download(item, true), {
    code: 'HTTP_403',
  });
  await assert.rejects(client(new Response('{}', { status: 429 })).download(item), {
    code: 'RATE_LIMIT_STOP',
  });
  await assert.rejects(
    client(new Response(bytes, { headers: { 'content-type': 'text/plain' } })).download(item),
    { code: 'OBJECT_METADATA_MISMATCH' }
  );
  await assert.rejects(
    client(
      new Response(Buffer.from('short'), { headers: { 'content-type': 'image/png' } })
    ).download(item),
    { code: 'OBJECT_SIZE_MISMATCH' }
  );
  assert.deepEqual(
    await client(new Response(bytes, { headers: { 'content-type': 'image/png' } })).download(item),
    bytes
  );
});

test('REST upload forbids upsert and supplies original MIME', async () => {
  const client = storageClient('https://unused.invalid', '', async (_, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-upsert'], 'false');
    assert.equal(options.headers['Content-Type'], item.mime_type);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return new Response('{}');
  });
  assert.equal(await client.upload(item, bytes), 'created');
});

test('local staging resumes with hash verification and refuses corrupt cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storage-migration-test-'));
  let reads = 0;
  const client = {
    download: async () => {
      reads++;
      return bytes;
    },
  };
  try {
    const initial = await stageObject(client, item, dir, 'manifest');
    assert.equal(initial.receipt.sha256, sha256(bytes));
    assert.equal((await stageObject(client, item, dir, 'manifest')).cached, true);
    assert.equal(reads, 1);
    await writeFile(join(dir, item.path), 'damaged');
    await assert.rejects(stageObject(client, item, dir, 'manifest'), {
      code: 'LOCAL_CACHE_CORRUPT',
    });
    assert.equal(reads, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('interrupted download leaves no completed local cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storage-migration-test-'));
  try {
    await assert.rejects(
      stageObject(
        {
          download: async () => {
            throw new Error('interrupted');
          },
        },
        item,
        dir,
        'manifest'
      )
    );
    assert.equal(
      (await stageObject({ download: async () => bytes }, item, dir, 'manifest')).cached,
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
