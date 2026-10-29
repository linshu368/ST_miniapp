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
    context: {
      ...context,
      outcome: i < 8 ? 'ready' : 'error',
      ...(i < 9 ? { tg_platform: i < 5 ? 'ios' : 'android', net_type: i < 5 ? '4g' : '3g' } : {}),
    },
  }));
  const events = Array.from({ length: 10 }, (_, i) => ({
    name: 'st_page_terminal',
    timestamp,
    domain: 'st.engineering',
    attributes: {
      ...context,
      outcome: i < 8 ? 'ready' : 'error',
      ...(i < 9 ? { tg_platform: i < 5 ? 'ios' : 'android', net_type: i < 5 ? '4g' : '3g' } : {}),
    },
  }));
  const firstTokens = [
    { model: 'synthetic-model-a', outcome: 'observed', ms: 1000 },
    { model: 'synthetic-model-a', outcome: 'observed', ms: 5999 },
    { model: 'synthetic-model-a', outcome: 'timed_out', ms: 6000 },
    { model: 'synthetic-model-a', outcome: 'page_left', ms: 770 },
    { model: 'synthetic-model-a', outcome: 'rejected', ms: 100 },
    { model: 'synthetic-model-b', outcome: 'observed', ms: 2000 },
  ];
  for (const sample of firstTokens) {
    const attrs = {
      schema_version: '1',
      measurement_version: 'engineering_v1',
      source_measurement_version: 'client_committed_v4',
      route: '/chat/:id',
      stage: 'first_token',
      action: 'send',
      requested_model: sample.model,
      deadline_ms: '6000',
      outcome: sample.outcome,
    };
    measurements.push({
      type: 'st_roleplay_first_token',
      timestamp,
      values: { duration_ms: sample.ms },
      context: attrs,
    });
    events.push({
      name: 'st_roleplay_terminal',
      timestamp,
      domain: 'st.engineering',
      attributes: attrs,
    });
  }
  const quality = [
    { playing_ms: '18000', rebuffer_ms: '2000', tg_platform: 'ios', net_type: '4g' },
    { playing_ms: '10000', rebuffer_ms: '0', tg_platform: 'ios', net_type: '4g' },
    { playing_ms: '5000', rebuffer_ms: '5000', tg_platform: 'android', net_type: '3g' },
    { playing_ms: '1000', rebuffer_ms: '0' }, // Old/missing dimensions must survive All.
    { playing_ms: '999' }, // Incomplete pair must not enter either side of the ratio.
    { playing_ms: '999', rebuffer_ms: 'invalid' },
  ];
  for (const sample of quality) {
    events.push({
      name: 'st_drama_playback_window',
      timestamp,
      domain: 'st.engineering',
      attributes: {
        schema_version: '1',
        measurement_version: 'engineering_v1',
        source_measurement_version: 'drama_playback_v1',
        stage: 'playback',
        route: '/',
        ...sample,
      },
    });
  }
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
          .replaceAll('$requested_model', '.*')
          .replaceAll('$deadline_ms', '6000')
          .replaceAll('$environment', 'test')
          .replaceAll('$release', '.*')
          .replaceAll('$measurement_version', 'engineering_v1')
          .replaceAll('$tg_platform', '.*')
          .replaceAll('$net_type', '.*')
          .replaceAll('$startup_definition', 'drama_v3')
          .replaceAll('$drama_route', '.*')
          .replaceAll('$startup_entry', '.*')
          .replaceAll('$startup_cache', '.*')
          .replaceAll('$startup_frame', '.*')
          .replaceAll('$catalog_start', '.*')
          .replaceAll('$__range', '10m')
          .replaceAll('$__auto', '10m');
        if (target.datasource?.type === 'prometheus') continue;
        const result = await query(expression);
        if (panel.id === 101) {
          const byModel = Object.fromEntries(
            result.map((r) => [r.metric.event_data_requested_model, Number(r.value[1])])
          );
          assert.equal(
            byModel['synthetic-model-a'],
            1 / 3,
            'Departure must not dilute cutoff rate'
          );
          assert.equal(byModel['synthetic-model-b'], 0);
        }
        if (panel.id === 102 && target.refId === 'B') {
          const a = result.find((r) => r.metric.context_requested_model === 'synthetic-model-a');
          assert.ok(Number(a?.value[1]) < 6000, 'Timeout must not enter successful P95');
        }
        if (panel.title.startsWith('已知页面终态成功率')) {
          assert.equal(Number(result[0]?.value?.[1]), 0.8);
          for (const [platform, net, expected] of [
            ['ios', '4g', 1],
            ['android', '3g', 0.75],
          ]) {
            const filtered = expression
              .replaceAll('event_data_tg_platform=~".*"', `event_data_tg_platform=~"${platform}"`)
              .replaceAll('event_data_net_type=~".*"', `event_data_net_type=~"${net}"`);
            assert.equal(Number((await query(filtered))[0]?.value[1]), expected);
          }
        }
        if (uid === 'st-engineering-drama' && [20, 21, 22].includes(panel.id)) {
          const expected = { 20: 34, 21: 7 / 41, 22: 4 }[panel.id];
          assert.equal(Number(result[0]?.value[1]), expected, 'Use the same complete pairs');
          const ios = expression
            .replaceAll('event_data_tg_platform=~".*"', 'event_data_tg_platform=~"ios"')
            .replaceAll('event_data_net_type=~".*"', 'event_data_net_type=~"4g"');
          const iosExpected = { 20: 28, 21: 1 / 15, 22: 2 }[panel.id];
          assert.equal(
            Number((await query(ios))[0]?.value[1]),
            iosExpected,
            'Time weighted, not mean of ratios'
          );
          const noSamples = expression.replaceAll(
            'event_data_tg_platform=~".*"',
            'event_data_tg_platform=~"no-samples"'
          );
          assert.equal((await query(noSamples)).length, 0, 'Missing data must not become zero');
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
