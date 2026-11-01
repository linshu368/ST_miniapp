import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  auditVideoSeedWorkbooks,
  closeVideoSeedImportResources,
  headVideoSize,
  selectBalancedTopVideoSeedRows,
  workbookSha256,
} from '../features/image-plaza/video-seed-import.js';

const options = parseArgs(process.argv.slice(2));
const audit = auditVideoSeedWorkbooks(options.input, options.translations);
const rows = audit.rows;
const failureByRow = new Map<
  number,
  { row_number: number; source_video_id: string; code: string }
>();
const bytesByRow = new Map<number, number>();
try {
  await measureRows(rows, 1);
  for (let round = 2; round <= 3; round += 1) {
    const retryRows = rows.filter((row) => !bytesByRow.has(row.rowNumber));
    if (!retryRows.length) break;
    console.log(`video seed size retry_round=${round} rows=${retryRows.length}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await measureRows(retryRows, round);
  }
} finally {
  await closeVideoSeedImportResources();
}
const failures = [...failureByRow.values()].sort(
  (left, right) => left.row_number - right.row_number
);
const accessibleRows = rows.filter((row) => bytesByRow.has(row.rowNumber));
const selection = selectBalancedTopVideoSeedRows(accessibleRows, options.targetCount);
const byModel: Record<string, { files: number; bytes: number }> = {};
let totalBytes = 0;
for (const row of selection.rows) {
  const bytes = bytesByRow.get(row.rowNumber);
  if (bytes === undefined) throw new Error('video_seed_size_selection_missing_measurement');
  totalBytes += bytes;
  const summary = byModel[row.sourceModelName] ?? { files: 0, bytes: 0 };
  summary.files += 1;
  summary.bytes += bytes;
  byModel[row.sourceModelName] = summary;
}
const report = {
  version: 2,
  generated_at: new Date().toISOString(),
  input_sha256: await workbookSha256(options.input),
  translations_sha256: await workbookSha256(options.translations),
  source_rows: audit.total,
  eligible_rows: audit.eligible,
  measured_rows: accessibleRows.length,
  target_rows: options.targetCount,
  selected_rows: selection.rows.length,
  total_bytes: totalBytes,
  by_model: byModel,
  selection_groups: selection.groups.map((group) => ({
    model_id: group.modelId,
    model_name: group.modelName,
    candidate_count: group.candidateCount,
    quota: group.quota,
    cutoff_heat: group.cutoffHeat,
    cutoff_tie_count: group.cutoffTieCount,
  })),
  selected: selection.rows.map((row) => ({
    row_number: row.rowNumber,
    source_video_id: row.sourceVideoId,
    model_id: row.modelId,
    source_heat: row.sourceHeat,
    bytes: bytesByRow.get(row.rowNumber),
  })),
  failures,
};
const contents = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(options.report, contents, 'utf8');
const reportHash = createHash('sha256').update(contents).digest('hex');
console.log(
  `video seed size report=${options.report} sha256=${reportHash} total_bytes=${totalBytes} failures=${failures.length}`
);
if (failures.length) process.exitCode = 1;

async function measureRows(measurementRows: typeof rows, round: number): Promise<void> {
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < measurementRows.length) {
      const row = measurementRows[cursor++];
      if (!row) return;
      try {
        bytesByRow.set(row.rowNumber, await headVideoSize(row.videoUrl));
        failureByRow.delete(row.rowNumber);
      } catch (err) {
        failureByRow.set(row.rowNumber, {
          row_number: row.rowNumber,
          source_video_id: row.sourceVideoId,
          code: err instanceof Error ? err.message.slice(0, 120) : 'head_failed',
        });
      } finally {
        completed += 1;
        const interval = round === 1 ? 100 : 10;
        if (completed % interval === 0 || completed === measurementRows.length) {
          console.log(
            `video seed size round=${round} progress=${completed}/${measurementRows.length} unresolved=${failureByRow.size}`
          );
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, measurementRows.length) }, () => worker()));
}

function parseArgs(args: string[]) {
  let input = '';
  let translations = '';
  let report = 'video-seed-size-report.json';
  let targetCount = 4_000;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--input') input = args[++index] ?? '';
    else if (args[index] === '--translations') translations = args[++index] ?? '';
    else if (args[index] === '--report') report = args[++index] ?? '';
    else if (args[index] === '--target-count') {
      targetCount = Number(args[++index] ?? '');
      if (!Number.isSafeInteger(targetCount) || targetCount < 1)
        throw new Error('invalid_target_count');
    } else throw new Error(`unknown_argument:${args[index] ?? ''}`);
  }
  if (!input || !translations)
    throw new Error('missing_required_argument:--input_and_--translations');
  const path = (value: string) =>
    isAbsolute(value) ? value : resolve(process.env.INIT_CWD || process.cwd(), value);
  return {
    input: path(input),
    translations: path(translations),
    report: path(report),
    targetCount,
  };
}
