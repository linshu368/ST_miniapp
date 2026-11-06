/** Reproduce the received-sample aggregates. Input is a PRIVATE local telemetry directory, never fixtures. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
if (!dir)
  throw new Error('Usage: node closure-20261104-analysis.mjs /private/tmp/st-bunny-close-20261103');
const rows = readdirSync(dir)
  .filter((n) => /^telemetry-\d+\.ndjson$/.test(n))
  .sort()
  .flatMap((n) =>
    readFileSync(join(dir, n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  );
const groups = new Map();
for (const r of rows) {
  if (!['playback', 'seek'].includes(r.type)) continue;
  const key = r.type + ':' + r.observation_id;
  const a = groups.get(key) ?? [];
  a.push(r);
  groups.set(key, a);
}
const obs = [];
for (const [id, a] of groups) {
  const finals = a.filter((r) => r.phase === 'final');
  const signature = (r) =>
    JSON.stringify([
      r.outcome,
      r.elapsed_ms,
      r.entry_elapsed_ms,
      r.delivery,
      r.marks,
      r.seek,
      r.frame_method,
    ]);
  const conflict =
    new Set(finals.map(signature)).size > 1 ||
    new Set(a.map((r) => r.experiment_user).filter(Boolean)).size > 1 ||
    new Set(a.map((r) => r.assigned_group).filter(Boolean)).size > 1;
  const r = finals[0] ?? a.reduce((x, y) => ((x.elapsed_ms ?? 0) > (y.elapsed_ms ?? 0) ? x : y));
  const verified =
    r.frame_method &&
    (r.type === 'seek'
      ? r.seek?.frameMs !== undefined
      : r.marks?.first_frame !== undefined && r.marks?.playing !== undefined);
  obs.push({
    id,
    group: conflict ? 'unknown' : (r.assigned_group ?? 'unknown'),
    provider: conflict ? 'unknown' : (r.delivery?.provider ?? 'unknown'),
    reason: r.delivery?.reason ?? 'unknown',
    platform: r.context?.platform ?? 'unknown',
    kind:
      r.type === 'seek'
        ? 'seek_' + (r.seek?.buffered ?? 'unknown')
        : r.entry === 'retry'
          ? 'startup_retry'
          : 'startup',
    elapsed: r.elapsed_ms,
    final: !!finals.length,
    start: a.some((r) => r.phase === 'start'),
    conflict,
    success: !conflict && !!finals.length && r.outcome === 'playing' && !!verified,
    outcome: conflict ? 'conflict' : r.outcome,
    release: r.context?.release ?? 'unknown',
    user: conflict ? undefined : r.experiment_user,
  });
}
function p95(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const p = (values.length - 1) * 0.95,
    i = Math.floor(p);
  return values[i] + (values[Math.ceil(p)] - values[i]) * (p - i);
}
function aggregate(keys) {
  const groups = new Map();
  for (const r of obs) {
    const key = keys.map((k) => r[k]).join(':');
    const a = groups.get(key) ?? [];
    a.push(r);
    groups.set(key, a);
  }
  return [...groups.values()].map((a) => ({
    ...Object.fromEntries(keys.map((k) => [k, a[0][k]])),
    attempts: a.length,
    users: new Set(a.map((r) => r.user).filter(Boolean)).size,
    successes: a.filter((r) => r.success).length,
    p95_ms: p95(a.filter((r) => r.success && Number.isFinite(r.elapsed)).map((r) => r.elapsed)),
    failures: a.filter((r) => ['error', 'unplayable', 'autoplay_blocked'].includes(r.outcome))
      .length,
    exits: a.filter((r) => ['left', 'switched', 'background'].includes(r.outcome)).length,
    unverified: a.filter(
      (r) => r.outcome === 'unverified' || (r.outcome === 'playing' && !r.success)
    ).length,
    missingStart: a.filter((r) => !r.start).length,
    missingFinal: a.filter((r) => !r.final).length,
    conflicts: a.filter((r) => r.conflict).length,
    outcomes: Object.fromEntries(
      [...new Set(a.map((r) => r.outcome))].map((k) => [k, a.filter((r) => r.outcome === k).length])
    ),
  }));
}
console.log(
  JSON.stringify(
    {
      observations: obs.length,
      by_group_kind: aggregate(['group', 'kind']),
      by_group_kind_provider: aggregate(['group', 'kind', 'provider', 'reason']),
      by_platform: aggregate(['group', 'kind', 'platform']),
      by_release: aggregate(['group', 'kind', 'release']),
    },
    null,
    2
  )
);
