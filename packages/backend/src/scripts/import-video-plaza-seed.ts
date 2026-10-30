import '../platform/config.js';
import { isAbsolute, resolve } from 'node:path';
import {
  auditVideoSeedWorkbooks,
  closeVideoSeedImportResources,
  selectBalancedTopVideoSeedRows,
  workbookSha256,
} from '../features/image-plaza/video-seed-import.js';
import { loadReviewedVideoSeedPlan } from '../features/image-plaza/video-seed-plan.js';

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  const audit = auditVideoSeedWorkbooks(options.input, options.translations);
  const selection = selectBalancedTopVideoSeedRows(audit.rows, 4_000);
  const inputSha256 = await workbookSha256(options.input);
  const translationsSha256 = await workbookSha256(options.translations);
  console.log(
    `video seed dry-run total=${audit.total} eligible=${audit.eligible} selected=${selection.rows.length} excluded=${audit.excluded} needs_repair=${audit.needsRepair} invalid=${audit.invalid} duplicate_ids=${audit.duplicateIds} translation_orphans=${audit.translationOrphans} input_sha256=${inputSha256} translations_sha256=${translationsSha256}`
  );
  for (const group of selection.groups) {
    console.log(
      `video seed selection model=${group.modelId} candidates=${group.candidateCount} quota=${group.quota} cutoff_heat=${group.cutoffHeat} cutoff_ties=${group.cutoffTieCount}`
    );
  }
  assertAuditBaseline(audit);
  if (options.reportHash) {
    const plan = await loadReviewedVideoSeedPlan({
      workbookPath: options.input,
      translationsPath: options.translations,
      reportPath: options.report,
      expectedReportSha256: options.reportHash,
    });
    console.log(`video seed reviewed_report verified=true sha256=${plan.reportSha256}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : 'video_seed_import_failed');
  exitCode = 1;
} finally {
  await closeVideoSeedImportResources().catch(() => {
    exitCode = 1;
  });
}
process.exitCode = exitCode;

interface Options {
  input: string;
  translations: string;
  report: string;
  reportHash: string;
}

function assertAuditBaseline(audit: ReturnType<typeof auditVideoSeedWorkbooks>): void {
  if (
    audit.total !== 5_097 ||
    audit.eligible !== 5_082 ||
    audit.excluded < 15 ||
    audit.needsRepair ||
    audit.invalid ||
    audit.duplicateIds ||
    audit.translationOrphans
  ) {
    throw new Error('video_seed_audit_baseline_mismatch');
  }
}

function parseArgs(args: string[]): Options {
  const result: Options = {
    input: '',
    translations: '',
    report: 'video-seed-size-report.json',
    reportHash: '',
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => args[++index] ?? '';
    if (arg === '--input') result.input = value();
    else if (arg === '--translations') result.translations = value();
    else if (arg === '--report') result.report = value();
    else if (arg === '--confirm-size') result.reportHash = value().toLowerCase();
    else if (arg === '--apply') throw new Error('video_seed_apply_removed_use_seed_assets');
    else throw new Error(`unknown_argument:${arg ?? ''}`);
  }
  if (!result.input || !result.translations) {
    throw new Error('video_seed_input_and_translations_required');
  }
  const path = (value: string) =>
    isAbsolute(value) ? value : resolve(process.env.INIT_CWD || process.cwd(), value);
  result.input = path(result.input);
  result.translations = path(result.translations);
  result.report = path(result.report);
  return result;
}
