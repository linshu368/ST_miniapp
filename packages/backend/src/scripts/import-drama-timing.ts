/** Bounded, dry-run-first import of an operator-verified Railway NDJSON export. */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DramaTimingReportSchema, type DramaTimingReport } from '@miniapp/shared';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function railwayDramaReport(
  value: unknown
): { report: DramaTimingReport; receivedAt: string } | undefined {
  const outer = object(value);
  if (!outer) return;
  let fields: Record<string, unknown> = { ...outer, ...object(decoded(outer.message)) };
  if (Array.isArray(outer.attributes)) {
    for (const item of outer.attributes) {
      const attribute = object(item);
      if (typeof attribute?.key === 'string') fields[attribute.key] = decoded(attribute.value);
    }
  } else if (object(outer.attributes)) {
    for (const [key, value] of Object.entries(object(outer.attributes)!))
      fields[key] = decoded(value);
  }
  if (fields.event !== 'drama.frontend_timing' || fields.type !== 'playback') return;
  const stages = Object.fromEntries(
    [
      'navigation',
      'address_wait',
      'address_to_source',
      'source_to_metadata',
      'metadata_to_frame',
      'source_to_frame',
      'source_to_playing',
    ].flatMap((name) => (fields[`${name}_ms`] === undefined ? [] : [[name, fields[`${name}_ms`]]]))
  );
  // Rebuild an allowlist report, never pass the log envelope or arbitrary attributes to storage.
  const report = DramaTimingReportSchema.parse({
    type: fields.type,
    phase: fields.phase,
    id: fields.observation_id,
    version: fields.version,
    context: decoded(fields.context),
    diagnostics: decoded(fields.diagnostics),
    entry: fields.entry,
    dramaId: fields.drama_id,
    videoId: fields.video_id,
    outcome: fields.outcome,
    elapsedMs: fields.elapsed_ms,
    marks: decoded(fields.marks),
    stages,
    addressSource: fields.address_source,
    frameMethod: fields.frame_method,
    queries: decoded(fields.queries),
    media: decoded(fields.media),
    queryDetailsTruncated: fields.query_details_truncated,
  });
  const time = fields.time ?? outer.timestamp;
  if (typeof time !== 'string' && typeof time !== 'number')
    throw new Error('missing_log_timestamp');
  const date = new Date(time);
  if (!Number.isFinite(date.valueOf())) throw new Error('invalid_log_timestamp');
  return { report, receivedAt: date.toISOString() };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const file = arg('--file');
  const environment = arg('--environment');
  const from = new Date(arg('--from') ?? '').valueOf();
  const to = new Date(arg('--to') ?? '').valueOf();
  if (
    !file ||
    !['test', 'production'].includes(environment ?? '') ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    to - from > 86_400_000
  )
    throw new Error(
      'usage: --file NDJSON --environment test|production --from ISO --to ISO (max 24h); optional --manifest JSON --apply --confirm-production'
    );
  if (statSync(file).size > 64 * 1024 * 1024) throw new Error('export_exceeds_64MiB');
  const content = readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 50_000) throw new Error('export_exceeds_50000_records_split_window');
  const reports: { report: DramaTimingReport; receivedAt: string }[] = [];
  let invalid = 0;
  for (const line of lines) {
    try {
      const parsed = railwayDramaReport(JSON.parse(line) as unknown);
      if (
        parsed &&
        new Date(parsed.receivedAt).valueOf() >= from &&
        new Date(parsed.receivedAt).valueOf() < to
      )
        reports.push(parsed);
    } catch {
      invalid += 1;
    }
  }
  let attested = false;
  const manifestPath = arg('--manifest');
  if (manifestPath) {
    if (statSync(manifestPath).size > 65536) throw new Error('manifest_too_large');
    const manifest = object(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
    attested =
      manifest?.environment === environment &&
      manifest?.complete === true &&
      manifest?.truncated === false &&
      manifest?.sourceRecordCount === lines.length &&
      manifest?.sha256 === createHash('sha256').update(content).digest('hex') &&
      new Date(String(manifest?.from)).valueOf() === from &&
      new Date(String(manifest?.to)).valueOf() === to;
    if (!attested) throw new Error('manifest_does_not_attest_exact_export_and_window');
  }
  const summary = {
    environment,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    source_records: lines.length,
    playback_reports: reports.length,
    observations: new Set(reports.map(({ report }) => report.id)).size,
    invalid,
    completeness: attested ? 'operator_attested' : 'unverified_partial_sample',
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  console.log(JSON.stringify(summary));
  if (!args.includes('--apply')) return;
  if (!attested || invalid > 0)
    throw new Error('apply_requires_complete_manifest_and_zero_invalid_records');
  if (environment === 'production' && !args.includes('--confirm-production'))
    throw new Error('production_confirmation_required');
  const { config } = await import('../platform/config.js');
  if (config.database.target !== environment)
    throw new Error('configured_database_environment_mismatch');
  const { DramaTimingRepository } = await import('../features/drama/timing-repository.js');
  const repository = new DramaTimingRepository();
  const results = { stored: 0, duplicate: 0, conflict: 0 };
  for (const { report, receivedAt } of reports) {
    const result = await repository.persist(
      report,
      { environment: environment!, release: 'railway_import' },
      receivedAt
    );
    results[result] += 1;
  }
  console.log(JSON.stringify(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error(
      'Drama import stopped; verify arguments, manifest and configured target. No raw log or credentials printed.'
    );
    process.exitCode = 1;
  });
}
