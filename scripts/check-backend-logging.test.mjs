import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectLogging, isRuntimeLogFile } from './check-backend-logging.mjs';

test('rejects fetch aliases, defaults and unused observation imports', () => {
  for (const source of [
    'const request = fetch; request(url);',
    'const request = options.fetchImpl ?? fetch;',
    'const request = globalThis.fetch;',
    "const request = globalThis['fetch'];",
    'const { fetch: request } = globalThis;',
    "import { clientFetch } from './observability/fetch.js'; fetch(url);",
    "import { fetch as request } from 'undici'; request(url);",
  ])
    assert.ok(inspectLogging(source, 'platform/test.ts').length, source);
});

test('accepts registered transports, observer callbacks, types and comments', () => {
  for (const source of [
    "import { clientFetch } from './observability/fetch.js'; const fetch=clientFetch('test', 'test'); const request = fetch; request(url);",
    "import { observedFetch } from './observability/fetch.js'; observedFetch('test',url,init,{},globalThis.fetch);",
    "import { fetch as request } from 'undici'; import { observedFetch } from './observability/fetch.js'; observedFetch('test',url,init,{},()=>request(url));",
    'const data: { fetch: typeof fetch } = { fetch: observedSupabaseFetch };',
    '// fetch(url); console.log(secret);\n const documentation="fetch(url)";',
  ])
    assert.deepEqual(inspectLogging(source, 'platform/test.ts'), [], source);
});

test('rejects global replacement even in primitive and requires scheduled job scope', () => {
  assert.ok(
    inspectLogging('globalThis.fetch = replacement;', 'platform/observability/fetch.ts').length
  );
  assert.ok(
    inspectLogging('setInterval(() => run(), 1000);', 'features/test/evaluation-job.ts').length
  );
  assert.deepEqual(
    inspectLogging(
      "import { runObservedJob } from '../../platform/observability/jobs.js'; setInterval(()=>runObservedJob('test',run),1000);",
      'features/test/evaluation-job.ts'
    ),
    []
  );
  assert.deepEqual(
    inspectLogging('setInterval(() => measure(), 1000);', 'lib/perf-metrics.ts'),
    []
  );
});

test('requires explicit observation for SDK clients and rejects unused registration', () => {
  for (const source of [
    "import {PrismaClient as Db} from '@prisma/client'; new Db();",
    "import {PrismaClient} from '@prisma/client'; import {applyPrismaObservation} from './observability/prisma.js'; const db=new PrismaClient(); db.user.findMany(); applyPrismaObservation(db);",
    "import {createClient} from '@supabase/supabase-js'; createClient(url,key);",
    "import {createClient} from '@supabase/supabase-js'; import {clientFetch} from './observability/fetch.js'; createClient(url,key,{global:{fetch: custom}});",
    "import pg from 'pg'; new pg.Pool();",
  ])
    assert.ok(inspectLogging(source, 'lib/client.ts').length, source);
  for (const source of [
    "import {PrismaClient} from '@prisma/client'; import {applyPrismaObservation} from './observability/prisma.js'; const db=applyPrismaObservation(new PrismaClient());",
    "import {PrismaClient} from '@prisma/client'; import {applyPrismaObservation} from './observability/prisma.js'; const raw=new PrismaClient(); const db=applyPrismaObservation(raw); db.user.findMany();",
    "import {createClient} from '@supabase/supabase-js'; import {clientFetch} from './observability/fetch.js'; const fetch=clientFetch('db','supabase'); const timeoutFetch=(url,init)=>fetch(url,init); createClient(url,key,{global:{fetch:timeoutFetch}});",
    "import {createClient} from '@supabase/supabase-js'; import {observedSupabaseFetch as observed} from './preparation-diagnostics.js'; createClient(url,key,{global:{fetch:observed}});",
  ])
    assert.deepEqual(inspectLogging(source, 'lib/client.ts'), [], source);
});

test('checks non-fetch HTTP calls, their aliases and actual observation scope', () => {
  for (const source of [
    "import {request as send} from 'undici'; send(url);",
    "import https from 'node:https'; https.get(url);",
    "import * as http from 'http'; const send=http.request; send(url);",
    "import {request} from 'undici'; import {observation} from './observability/runtime.js'; observation.observe('unused',()=>ok()); request(url);",
  ])
    assert.ok(inspectLogging(source, 'lib/http.ts').length, source);
  assert.deepEqual(
    inspectLogging(
      "import {request} from 'undici'; import {observation} from './observability/runtime.js'; observation.observe('request',()=>request(url));",
      'lib/http.ts'
    ),
    []
  );
});

test('checks each timer and polling round independently of file name or other wrapped callbacks', () => {
  const job = "import {runObservedJob} from './observability/jobs.js'; ";
  for (const source of [
    'setInterval(()=>work(),1000);',
    job + "setInterval(()=>runObservedJob('ok',work),1000); setInterval(()=>work(),1000);",
    job + "const unused=()=>runObservedJob('unused',work); setInterval(()=>work(),1000);",
    "import {setTimeout as sleep} from 'node:timers/promises'; while(!signal.aborted){ await work(); await sleep(1000); }",
    job +
      "while(true){ const unused=()=>runObservedJob('unused',work); await work(); await input.sleep(1000); }",
  ])
    assert.ok(inspectLogging(source, 'features/example/runner.ts').length, source);
  for (const source of [
    job + "const tick=()=>runObservedJob('ok',work); setInterval(()=>void tick(),1000);",
    job + "async function tick(){return runObservedJob('ok',work)} setInterval(tick,1000);",
    job + "while(!signal.aborted){ await runObservedJob('round',work); await input.sleep(1000); }",
  ])
    assert.deepEqual(inspectLogging(source, 'features/example/runner.ts'), [], source);
});

test('prevents a local fetch registration from exempting another scope', () => {
  const registration = "import {clientFetch} from './observability/fetch.js'; ";
  assert.ok(
    inspectLogging(
      registration +
        "function unused(){const fetch=clientFetch('ok','ok'); fetch(url)} fetch(url);",
      'lib/test.ts'
    ).length
  );
  assert.ok(
    inspectLogging(
      registration + "const fetch=clientFetch('ok','ok'); function raw(fetch){fetch(url)}",
      'lib/test.ts'
    ).length
  );
});

test('retains database causes and validates the dedicated PostgreSQL exception', () => {
  assert.ok(inspectLogging('throw new Error(error.message);', 'lib/error.ts').length);
  assert.ok(inspectLogging('throw new Error(error.message, {});', 'lib/error.ts').length);
  assert.deepEqual(
    inspectLogging('throw new Error(error.message, {cause:error});', 'lib/error.ts'),
    []
  );
  assert.ok(
    inspectLogging("import {Client} from 'pg'; new Client();", 'lib/postgres-advisory-lease.ts')
      .length
  );
});

test('checks new script entry points by default and keeps reviewed offline protocols explicit', () => {
  assert.equal(isRuntimeLogFile('scripts/new-worker.ts'), true);
  assert.equal(isRuntimeLogFile('scripts/reconcile-payment-orders.ts'), true);
  assert.equal(isRuntimeLogFile('scripts/payment-callback-report.ts'), false);
  assert.equal(isRuntimeLogFile('features/example/runner.ts'), true);
});
