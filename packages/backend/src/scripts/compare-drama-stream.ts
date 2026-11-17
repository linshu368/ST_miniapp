/** Bounded local export only. Retain assigned arms and full retry-root waiting time. */
import { readFileSync, statSync } from 'node:fs';
import { railwayDramaReport } from './railway-drama-report.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = option('--file');
const experiment = option('--experiment');
const from = Date.parse(option('--from') || '');
const to = Date.parse(option('--to') || '');
const environment = option('--environment');
if (
  !file ||
  !experiment ||
  !['test', 'production'].includes(environment || '') ||
  !Number.isFinite(from) ||
  !Number.isFinite(to) ||
  from >= to ||
  to - from > 14 * 86400000 ||
  statSync(file).size > 64 * 1024 * 1024
)
  throw new Error('invalid_export_arguments_max_14d_64MiB');
type Row = NonNullable<ReturnType<typeof railwayDramaReport>>;
const roots = new Map<string, Row[]>();
let invalid = 0;
const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
if (lines.length > 50000) throw new Error('export_exceeds_50000_records');
for (const line of lines) {
  try {
    const row = railwayDramaReport(JSON.parse(line), true);
    if (
      !row ||
      row.environment !== environment ||
      row.experimentId !== experiment ||
      Date.parse(row.receivedAt) < from ||
      Date.parse(row.receivedAt) >= to
    )
      continue;
    const report = row.report;
    const startup = report.type === 'playback';
    if (
      startup
        ? report.entry !== 'cover' && !report.recovery?.rootId
        : report.seek?.direction !== 'forward' ||
          report.seek?.wasPlaying !== true ||
          report.seek.buffered !== 'no'
    )
      continue;
    const root = `${report.type}:${startup ? (report.recovery?.rootId ?? report.id) : report.id}`;
    roots.set(root, [...(roots.get(root) ?? []), row]);
  } catch {
    invalid++;
  }
}
const groups = new Map<
  string,
  {
    users: Set<string>;
    attempts: number;
    missing: number;
    conflicts: number;
    successes: number[];
    withinThree: number;
    fallbacks: number;
    outcomes: Record<string, number>;
  }
>();
for (const rows of roots.values()) {
  if (
    rows[0]!.report.type === 'playback' &&
    !rows.some((r) => r.report.entry === 'cover' && !r.report.recovery?.parentId)
  )
    continue;
  const identity = new Set(rows.map((r) => r.assignedGroup));
  const row = rows[0]!;
  const group = identity.size === 1 ? (row.assignedGroup ?? 'unknown') : 'unknown';
  const key = `${row.report.type}:${group}`;
  const metric = groups.get(key) ?? {
    users: new Set<string>(),
    attempts: 0,
    missing: 0,
    conflicts: 0,
    successes: [],
    withinThree: 0,
    fallbacks: 0,
    outcomes: {} as Record<string, number>,
  };
  metric.attempts++;
  rows.forEach((r) => {
    if (r.experimentUser) metric.users.add(r.experimentUser);
  });
  const finals = rows.filter((r) => r.report.phase === 'final');
  const terminal = new Map<string, Set<string>>();
  for (const r of finals)
    terminal.set(
      r.report.id,
      new Set([...(terminal.get(r.report.id) ?? []), JSON.stringify(r.report)])
    );
  const conflict = identity.size > 1 || [...terminal.values()].some((v) => v.size > 1);
  if (conflict) metric.conflicts++;
  if (!finals.length) metric.missing++;
  const success = finals.filter(
    (r) =>
      r.report.outcome === 'playing' &&
      (r.report.type === 'playback'
        ? r.report.marks.first_frame !== undefined && r.report.marks.playing !== undefined
        : r.report.seek?.frameMs !== undefined)
  );
  if (!conflict && success.length) {
    const elapsed = Math.max(
      ...success.map((r) =>
        Math.max(
          r.report.entryElapsedMs ?? 0,
          r.report.recovery?.cumulativeMs ?? r.report.elapsedMs
        )
      )
    );
    metric.successes.push(elapsed);
    if (elapsed <= 3000) metric.withinThree++;
  }
  const rootOutcome = conflict
    ? 'conflict'
    : success.length
      ? 'playing'
      : (finals.at(-1)?.report.outcome ?? 'missing_final');
  metric.outcomes[rootOutcome] = (metric.outcomes[rootOutcome] ?? 0) + 1;
  if (rows.some((r) => r.report.delivery?.reason === 'fallback')) metric.fallbacks++;
  groups.set(key, metric);
}
console.log(
  JSON.stringify(
    {
      experiment,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      invalid,
      groups: [...groups].map(([key, { users, successes, ...rest }]) => {
        successes.sort((a, b) => a - b);
        return {
          key,
          ...rest,
          distinctUsers: users.size,
          measuredSuccesses: successes.length,
          p95Ms: successes.length ? successes[Math.ceil(successes.length * 0.95) - 1] : null,
          withinThreeSeconds: rest.withinThree,
          withinThreeSecondsRate: rest.attempts ? rest.withinThree / rest.attempts : null,
        };
      }),
      coverage:
        'Verify complete exports; missing/offline reports remain unknown. P95 uses measurable successes. Retry roots are counted once; subgroup confidence requires separate user-cluster analysis.',
    },
    null,
    2
  )
);
