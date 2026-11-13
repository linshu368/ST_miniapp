import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectLogging } from './check-backend-logging.mjs';

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
