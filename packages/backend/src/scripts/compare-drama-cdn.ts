/** Read-only comparison of a bounded, operator-exported Railway log window. No DB or provider calls. */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { railwayDramaReport } from './import-drama-timing.js';

type Row = NonNullable<ReturnType<typeof railwayDramaReport>>;
interface Window {
  environment: string;
  experimentId: string;
  from: number;
  to: number;
  release?: string;
  serverRelease?: string;
}

export function compareDramaCdn(records: unknown[], window: Window) {
  const observations = new Map<string, Row[]>();
  let invalid = 0;
  let excluded = 0;
  for (const record of records) {
    try {
      const row = railwayDramaReport(record, true);
      if (!row) continue;
      const at = Date.parse(row.receivedAt);
      if (
        row.environment !== window.environment ||
        row.experimentId !== window.experimentId ||
        at < window.from ||
        at >= window.to ||
        (window.release && row.report.context?.release !== window.release) ||
        (window.serverRelease && row.serverRelease !== window.serverRelease)
      ) {
        excluded++;
        continue;
      }
      const rows = observations.get(row.report.id) ?? [];
      rows.push(row);
      observations.set(row.report.id, rows);
    } catch {
      invalid++;
    }
  }
  const groups = new Map<
    string,
    {
      platform: string;
      kind: string;
      group: string;
      provider: string;
      attempts: number;
      users: Set<string>;
      affected: Set<string>;
      overFiveSeconds: number;
      failures: number;
      exits: number;
      missingFinal: number;
      missingStart: number;
      unknownUsers: number;
      conflicts: number;
      successes: number;
      unverified: number;
      outcomes: Partial<Record<Row['report']['outcome'] | 'conflict', number>>;
    }
  >();
  const overLimit: {
    id: string;
    platform: string;
    kind: string;
    group: string;
    provider: string;
    elapsedMs: number;
    entryElapsedMs?: number;
    cumulativeMs?: number;
    finalKnown: boolean;
    observedWaitMs: number;
    outcome: string;
    marks: Row['report']['marks'];
    stages: Row['report']['stages'];
  }[] = [];
  const allUsers = new Set<string>();
  const releases = new Set<string>();
  const serverReleases = new Set<string>();
  let duplicates = 0;
  for (const [id, rows] of observations) {
    const finals = rows.filter((row) => row.report.phase === 'final');
    const uniqueFinals = new Set(finals.map((row) => JSON.stringify(row.report)));
    duplicates += finals.length - uniqueFinals.size;
    const identities = new Set(rows.map((row) => row.experimentUser).filter(Boolean));
    const assigned = new Set(rows.map((row) => row.assignedGroup).filter(Boolean));
    // Conflicting terminal facts must not be resolved by selecting the fastest success.
    const conflict =
      uniqueFinals.size > 1 ||
      identities.size > 1 ||
      assigned.size > 1 ||
      rows.some(
        (row) =>
          row.report.delivery &&
          (row.report.delivery.experimentId !== row.experimentId ||
            row.report.delivery.group !== row.assignedGroup)
      );
    const chosen =
      finals[0] ?? rows.reduce((a, b) => (a.report.elapsedMs >= b.report.elapsedMs ? a : b));
    const report = chosen.report;
    const platform = report.context?.platform ?? 'unknown';
    const kind = report.type === 'seek' ? `seek_${report.seek?.buffered ?? 'unknown'}` : 'startup';
    const group = conflict
      ? 'unknown'
      : (rows.find((row) => row.assignedGroup)?.assignedGroup ?? 'unknown');
    const provider = conflict ? 'unknown' : (report.delivery?.provider ?? 'unknown');
    const key = [platform, kind, group, provider].join(':');
    const metric = groups.get(key) ?? {
      platform,
      kind,
      group,
      provider,
      attempts: 0,
      users: new Set<string>(),
      affected: new Set<string>(),
      overFiveSeconds: 0,
      failures: 0,
      exits: 0,
      missingFinal: 0,
      missingStart: 0,
      unknownUsers: 0,
      conflicts: 0,
      successes: 0,
      unverified: 0,
      outcomes: {} as Partial<Record<Row['report']['outcome'] | 'conflict', number>>,
    };
    metric.attempts++;
    const user = conflict ? undefined : rows.find((row) => row.experimentUser)?.experimentUser;
    if (user) {
      metric.users.add(user);
      allUsers.add(user);
    } else metric.unknownUsers++;
    if (report.context) releases.add(report.context.release);
    if (chosen.serverRelease) serverReleases.add(chosen.serverRelease);
    if (!finals.length) metric.missingFinal++;
    if (!rows.some((row) => row.report.phase === 'start')) metric.missingStart++;
    if (conflict) metric.conflicts++;
    const outcome = conflict ? 'conflict' : report.outcome;
    metric.outcomes[outcome] = (metric.outcomes[outcome] ?? 0) + 1;
    const verified =
      report.frameMethod &&
      (report.type === 'seek'
        ? report.seek?.frameMs !== undefined
        : report.marks.first_frame !== undefined && report.marks.playing !== undefined);
    if (!conflict && finals.length && report.outcome === 'playing' && verified) metric.successes++;
    if (
      !conflict &&
      (report.outcome === 'unverified' || (report.outcome === 'playing' && !verified))
    )
      metric.unverified++;
    if (!conflict && ['error', 'unplayable', 'autoplay_blocked'].includes(report.outcome))
      metric.failures++;
    if (!conflict && ['left', 'switched', 'background'].includes(report.outcome)) metric.exits++;
    const elapsed = Math.max(
      ...rows.map((row) =>
        Math.max(
          row.report.elapsedMs,
          row.report.entryElapsedMs ?? 0,
          row.report.recovery?.cumulativeMs ?? 0
        )
      )
    );
    if (elapsed > 5000) {
      metric.overFiveSeconds++;
      if (user) metric.affected.add(user);
      overLimit.push({
        id,
        platform,
        kind,
        group,
        provider,
        elapsedMs: report.elapsedMs,
        entryElapsedMs: report.entryElapsedMs,
        cumulativeMs: report.recovery?.cumulativeMs,
        finalKnown: finals.length > 0 && !conflict,
        observedWaitMs: elapsed,
        outcome: conflict ? 'conflict' : report.outcome,
        marks: report.marks,
        stages: report.stages,
      });
    }
    groups.set(key, metric);
  }
  return {
    environment: window.environment,
    experimentId: window.experimentId,
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    observations: observations.size,
    distinctUsers: allUsers.size,
    invalid,
    excluded,
    duplicates,
    releases: [...releases],
    serverReleases: [...serverReleases],
    comparability:
      invalid || releases.size !== 1 || serverReleases.size !== 1
        ? 'requires_review'
        : 'descriptive_only_sample_sufficiency_requires_review',
    groups: [...groups.values()].map(({ users, affected, ...metric }) => ({
      ...metric,
      distinctUsers: users.size,
      affectedUsers: affected.size,
      overFiveSecondsRate: metric.overFiveSeconds / metric.attempts,
      affectedUserRate: users.size ? affected.size / users.size : null,
    })),
    overLimit,
    coverage:
      'Received logs only; missing/offline reports are unknown. seek_no is the unbuffered comparison. Cumulative retry elapsed includes retry gaps. No automatic success or traffic expansion.',
  };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const file = arg('--file');
  const environment = arg('--environment');
  const experimentId = arg('--experiment');
  const from = Date.parse(arg('--from') ?? '');
  const to = Date.parse(arg('--to') ?? '');
  if (
    !file ||
    !['test', 'production'].includes(environment ?? '') ||
    !experimentId ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    to - from > 86400000
  )
    throw new Error(
      'usage: --file NDJSON --environment test|production --experiment ID --from ISO --to ISO (max 24h) [--release ID] [--server-release ID]'
    );
  if (statSync(file).size > 64 * 1024 * 1024) throw new Error('export_exceeds_64MiB');
  const content = readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 50000) throw new Error('export_exceeds_50000_records_split_window');
  const records = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  });
  const result = compareDramaCdn(records, {
    environment: environment!,
    experimentId,
    from,
    to,
    release: arg('--release'),
    serverRelease: arg('--server-release'),
  });
  console.log(
    JSON.stringify({
      ...result,
      sourceRecords: lines.length,
      invalidJson: records.filter((record) => record === null).length,
      completeness: 'operator_must_verify_full_export_not_truncated',
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    console.error('drama_cdn_comparison_failed_check_arguments_and_export');
    process.exitCode = 1;
  }
}
