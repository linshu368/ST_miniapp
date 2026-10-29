// 只用本机、虚构样本。没有 Cloud token，不调用业务 API/付费模型。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = fileURLToPath(new URL('./config.alloy', import.meta.url));
const name = `st-observability-contract-${process.pid}`;
const containers = [];
let network;
let lokiUrl;
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      /* Starting. */
    }
    await sleep(250);
  }
  throw new Error('Local contract check timed out');
}

try {
  network = docker('network', 'create', name);
  const loki = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    `${name}-loki`,
    '--network',
    name,
    '--network-alias',
    'st-observability-loki',
    '-p',
    '127.0.0.1::3100',
    'grafana/loki:3.5.0',
    '-config.file=/etc/loki/local-config.yaml'
  );
  containers.push(loki);
  const lokiPort = docker('port', loki, '3100/tcp').split(':').at(-1);
  lokiUrl = `http://127.0.0.1:${lokiPort}`;
  await waitUntil(async () => (await fetch(`${lokiUrl}/ready`)).ok);

  const alloy = docker(
    'run',
    '-d',
    '--rm',
    '--name',
    `${name}-alloy`,
    '--network',
    name,
    '-p',
    '127.0.0.1::12347',
    '-p',
    '127.0.0.1::12345',
    '-v',
    `${config}:/etc/alloy/config.alloy:ro`,
    'grafana/alloy:v1.21.0',
    'run',
    '--server.http.listen-addr=0.0.0.0:12345',
    '/etc/alloy/config.alloy'
  );
  containers.push(alloy);
  const faroPort = docker('port', alloy, '12347/tcp').split(':').at(-1);
  const alloyPort = docker('port', alloy, '12345/tcp').split(':').at(-1);
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${alloyPort}/-/ready`)).ok);
  const timestamp = new Date().toISOString();
  const context = {
    schema_version: '1',
    measurement_version: 'engineering_v1',
    source_measurement_version: 'page_mount_v1',
    route: '/characters',
    navigation_type: 'mount',
    visibility: 'foreground',
    stage: 'ready',
  };
  const measurements = Array.from({ length: 10 }, (_, i) => ({
    type: 'st_page_ready',
    timestamp,
    values: { duration_ms: i < 8 ? 1000 : 5000 },
    context: { ...context, outcome: i < 8 ? 'ready' : 'error' },
  }));
  const events = Array.from({ length: 10 }, (_, i) => ({
    name: 'st_page_terminal',
    timestamp,
    domain: 'st.engineering',
    attributes: { ...context, outcome: i < 8 ? 'ready' : 'error' },
  }));
  const response = await fetch(`http://127.0.0.1:${faroPort}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      meta: { app: { name: 'st-miniapp', version: 'local-contract', environment: 'test' } },
      measurements,
      events,
    }),
  });
  assert.equal(response.status, 202, `Faro receiver: ${response.status} ${await response.text()}`);
  await sleep(1500);
  const inspectUrl = new URL('/loki/api/v1/query_range', lokiUrl);
  inspectUrl.searchParams.set('query', '{app="st-miniapp"}');
  inspectUrl.searchParams.set('limit', '2');
  const inspect = await (await fetch(inspectUrl)).json();
  console.log('Synthetic wire sample:', JSON.stringify(inspect.data?.result));

  async function query(expression) {
    const url = new URL('/loki/api/v1/query', lokiUrl);
    url.searchParams.set('query', expression);
    const result = await (await fetch(url)).json();
    assert.equal(result.status, 'success', JSON.stringify(result));
    return result.data.result;
  }
  const base = '{app="st-miniapp"} | logfmt | kind="measurement" | type="st_page_ready"';
  const success = `${base} | context_outcome="ready"`;
  const countQuery = `sum(count_over_time(${base} [10m]))`;
  await waitUntil(async () => (await query(countQuery))[0]?.value?.[1] === '10');
  const p95 = await query(
    `quantile_over_time(0.95, ${success} | unwrap duration_ms | __error__="" [10m]) by (context_route)`
  );
  assert.equal(Number(p95[0]?.value?.[1]), 1000, 'Failed waits must not contaminate success P95');
  const terminals = await query(
    'sum by (event_data_outcome) (count_over_time({app="st-miniapp"} | logfmt | kind="event" | event_name="st_page_terminal" [10m]))'
  );
  assert.deepEqual(
    Object.fromEntries(
      terminals.map((row) => [row.metric.event_data_outcome, Number(row.value[1])])
    ),
    { error: 2, ready: 8 }
  );
  let queriesChecked = 0;
  for (const uid of ['st-engineering-pages', 'st-engineering-roleplay', 'st-engineering-drama']) {
    const dashboard = JSON.parse(
      await readFile(new URL(`../../../docs/grafana/${uid}.json`, import.meta.url), 'utf8')
    );
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        const expression = target.expr
          .replaceAll('${browser_selector:raw}', '{app="st-miniapp"}')
          .replaceAll('$environment', 'test')
          .replaceAll('$release', '.*')
          .replaceAll('$measurement_version', 'engineering_v1')
          .replaceAll('$__range', '10m')
          .replaceAll('$__auto', '10m');
        const result = await query(expression);
        if (panel.title.startsWith('已知页面终态成功率')) {
          assert.equal(Number(result[0]?.value?.[1]), 0.8);
        }
        queriesChecked++;
      }
    }
  }
  console.log(
    JSON.stringify({ count: 10, p95_success_ms: p95, terminals, queriesChecked }, null, 2)
  );
  console.log('PASS: Faro payload → pinned Alloy → Loki → count / success P95 / outcomes');
} catch (error) {
  if (lokiUrl) {
    console.error(
      'Local labels:',
      JSON.stringify(await (await fetch(`${lokiUrl}/loki/api/v1/labels`)).json())
    );
  }
  for (const id of containers) {
    try {
      console.error(docker('logs', '--tail', '15', id));
    } catch {
      /* Diagnostics only. */
    }
  }
  throw error;
} finally {
  for (const id of containers.reverse()) {
    try {
      docker('stop', '--time', '2', id);
    } catch {
      /* Only this run's IDs. */
    }
  }
  if (network) {
    try {
      docker('network', 'rm', network);
    } catch {
      /* Reported by Docker. */
    }
  }
}
