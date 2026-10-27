import '../platform/config.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  auditVideoSeedWorkbooks,
  importVideoSeedRow,
  workbookSha256,
} from '../features/image-plaza/video-seed-import.js';
import { getImagePlazaRuntimeConfig } from '../features/image-plaza/config.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  const audit = auditVideoSeedWorkbooks(options.input, options.translations);
  console.log(
    `video seed ${options.apply ? 'apply' : 'dry-run'} total=${audit.total} eligible=${audit.eligible} excluded=${audit.excluded} needs_repair=${audit.needsRepair} invalid=${audit.invalid} duplicate_ids=${audit.duplicateIds} translation_orphans=${audit.translationOrphans} input_sha256=${await workbookSha256(options.input)} translations_sha256=${await workbookSha256(options.translations)}`
  );
  if (
    audit.total !== 5_097 ||
    audit.eligible !== 5_082 ||
    audit.excluded < 15 ||
    audit.needsRepair ||
    audit.invalid ||
    audit.duplicateIds ||
    audit.translationOrphans
  )
    throw new Error('video_seed_audit_baseline_mismatch');
  if (options.apply) {
    await assertApplyGates(options);
    const runtime = await getImagePlazaRuntimeConfig();
    if (!runtime.videoCatalog) throw new Error('video_seed_catalog_unavailable');
    const selected = audit.rows.slice(options.offset, options.offset + options.limit);
    let imported = 0;
    let alreadyImported = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < selected.length) {
        const row = selected[cursor++];
        if (!row) return;
        try {
          const status = await importVideoSeedRow(row, runtime.videoCatalog!);
          if (status === 'imported') imported += 1;
          else alreadyImported += 1;
        } catch (err) {
          failed += 1;
          console.error(
            `video seed row failed row=${row.rowNumber} id=${row.sourceVideoId} code=${err instanceof Error ? err.message : 'unknown'}`
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, selected.length) }, () => worker())
    );
    console.log(
      `video seed apply selected=${selected.length} imported=${imported} already_imported=${alreadyImported} failed=${failed}`
    );
    if (failed) exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : 'video_seed_import_failed');
  exitCode = 1;
} finally {
  await closeSupabaseClient().catch(() => {
    exitCode = 1;
  });
}
process.exitCode = exitCode;

interface Options {
  input: string;
  translations: string;
  report: string;
  confirmSize: string;
  apply: boolean;
  target?: 'test' | 'production';
  confirmProduction: boolean;
  offset: number;
  limit: number;
  concurrency: number;
}
async function assertApplyGates(options: Options) {
  if (!options.confirmSize) throw new Error('video_seed_apply_requires_confirm_size');
  const reportHash = createHash('sha256')
    .update(await readFile(options.report))
    .digest('hex');
  if (reportHash !== options.confirmSize.toLowerCase())
    throw new Error('video_seed_size_report_hash_mismatch');
  if (!options.target || options.target !== config.database.target)
    throw new Error('video_seed_target_mismatch');
  if (options.target === 'production' && !options.confirmProduction)
    throw new Error('video_seed_production_requires_confirmation');
}
function parseArgs(args: string[]): Options {
  const result: Options = {
    input: '',
    translations: '',
    report: 'video-seed-size-report.json',
    confirmSize: '',
    apply: false,
    confirmProduction: false,
    offset: 0,
    limit: 100,
    concurrency: 1,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => args[++index] ?? '';
    if (arg === '--input') result.input = value();
    else if (arg === '--translations') result.translations = value();
    else if (arg === '--report') result.report = value();
    else if (arg === '--confirm-size') result.confirmSize = value();
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--confirm-production') result.confirmProduction = true;
    else if (arg === '--target') {
      const target = value();
      if (target !== 'test' && target !== 'production') throw new Error('invalid_target');
      result.target = target;
    } else if (arg === '--offset')
      result.offset = integer(value(), 0, Number.MAX_SAFE_INTEGER, arg);
    else if (arg === '--limit') result.limit = integer(value(), 1, 500, arg);
    else if (arg === '--concurrency') result.concurrency = integer(value(), 1, 4, arg);
    else throw new Error(`unknown_argument:${arg ?? ''}`);
  }
  if (!result.input || !result.translations)
    throw new Error('video_seed_input_and_translations_required');
  const path = (value: string) =>
    isAbsolute(value) ? value : resolve(process.env.INIT_CWD || process.cwd(), value);
  result.input = path(result.input);
  result.translations = path(result.translations);
  result.report = path(result.report);
  return result;
}
function integer(value: string, min: number, max: number, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`invalid_integer:${name}`);
  return parsed;
}
