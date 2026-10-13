import '../platform/config.js';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  auditSeedWorkbook,
  closeSeedImportResources,
  importSeedRow,
  readSeedApprovalManifest,
  type SeedApprovalManifest,
} from '../features/image-plaza/seed-import.js';
import { getImagePlazaRuntimeConfig } from '../features/image-plaza/config.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';

interface CliOptions {
  input: string;
  manifest?: string;
  apply: boolean;
  target?: 'test' | 'production';
  confirmOriginalStorage: boolean;
  confirmProduction: boolean;
  offset: number;
  limit?: number;
  concurrency: number;
}

const log = createLogger('image-plaza-seed-import');
let exitCode = 0;

try {
  const options = parseArgs(process.argv.slice(2));
  const approval: SeedApprovalManifest | undefined = options.manifest
    ? await readSeedApprovalManifest(options.manifest)
    : undefined;
  const audit = auditSeedWorkbook(options.input, approval);
  console.log(
    [
      `Image plaza seed ${options.apply ? 'apply' : 'dry-run'}:`,
      `total=${audit.total}`,
      `eligible=${audit.eligible}`,
      `over_prompt_limit=${audit.overPromptLimit}`,
      `unapproved=${audit.unapproved}`,
      `invalid=${audit.invalid}`,
      `duplicate_source_ids=${audit.duplicateSourceIds}`,
      `duplicate_image_urls=${audit.duplicateImageUrls}`,
      `approved_ids_not_found=${audit.approvedIdsNotFound}`,
    ].join(' ')
  );

  if (!options.apply) {
    if (!approval) {
      console.log(
        'Approval manifest not provided; dry-run reports structural and prompt eligibility only.'
      );
    }
  } else {
    assertApplyGates(options, approval);
    if (audit.approvedIdsNotFound > 0) throw new Error('approved_manifest_contains_unknown_ids');
    const runtime = await getImagePlazaRuntimeConfig();
    const models = new Map(runtime.catalog.models.map((model) => [model.id, model]));
    const selected = audit.rows.slice(
      options.offset,
      options.limit === undefined ? undefined : options.offset + options.limit
    );
    let imported = 0;
    let alreadyImported = 0;
    let failed = 0;

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < selected.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = selected[index];
        if (!row) return;
        const model = models.get(row.modelId);
        if (!model) {
          failed += 1;
          log.sys.error(
            {
              event: 'image_plaza.seed.model_missing',
              sourceImageId: row.sourceImageId,
              rowNumber: row.rowNumber,
              modelId: row.modelId,
            },
            '初始作品映射模型不在运行时目录中'
          );
          continue;
        }
        try {
          const result = await importSeedRow(row, model);
          if (result.status === 'imported') imported += 1;
          else alreadyImported += 1;
        } catch (err) {
          failed += 1;
          log.sys.error(
            {
              event: 'image_plaza.seed.row_failed',
              err,
              sourceImageId: row.sourceImageId,
              rowNumber: row.rowNumber,
              modelId: row.modelId,
            },
            '初始作品导入失败'
          );
        }
        if (nextIndex < selected.length) await sleep(250);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, selected.length) }, () => worker())
    );

    console.log(
      `Image plaza seed apply complete: selected=${selected.length} concurrency=${options.concurrency} imported=${imported} ` +
        `already_imported=${alreadyImported} failed=${failed}`
    );
    if (failed > 0) exitCode = 1;
  }
} catch (err) {
  log.sys.error({ event: 'image_plaza.seed.import_failed', err }, '初始作品导入任务失败');
  console.error(err instanceof Error ? err.message : 'image_plaza_seed_import_failed');
  exitCode = 1;
} finally {
  try {
    await closeSeedImportResources();
  } catch (err) {
    log.sys.error(
      { event: 'image_plaza.seed.proxy_cleanup_failed', err },
      '初始作品代理资源清理失败'
    );
    exitCode = 1;
  }
  try {
    await closeSupabaseClient();
  } catch (err) {
    log.sys.error({ event: 'image_plaza.seed.cleanup_failed', err }, '初始作品导入资源清理失败');
    exitCode = 1;
  }
}

process.exitCode = exitCode;

function assertApplyGates(options: CliOptions, approval?: SeedApprovalManifest): void {
  if (!approval || !options.manifest) throw new Error('apply_requires_approved_manifest');
  if (!options.confirmOriginalStorage) throw new Error('apply_requires_confirm_original_storage');
  if (options.limit === undefined) throw new Error('apply_requires_explicit_batch_limit');
  if (!options.target) throw new Error('apply_requires_explicit_target');
  if (options.target !== config.database.target) {
    throw new Error(
      `apply_target_mismatch:requested=${options.target},configured=${config.database.target}`
    );
  }
  if (options.target === 'production' && !options.confirmProduction) {
    throw new Error('production_apply_requires_confirm_production');
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    input: '',
    apply: false,
    confirmOriginalStorage: false,
    confirmProduction: false,
    offset: 0,
    concurrency: 1,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--confirm-original-storage') options.confirmOriginalStorage = true;
    else if (arg === '--confirm-production') options.confirmProduction = true;
    else if (arg === '--input') options.input = requireValue(args, ++index, arg);
    else if (arg === '--manifest') options.manifest = requireValue(args, ++index, arg);
    else if (arg === '--target') {
      const target = requireValue(args, ++index, arg);
      if (target !== 'test' && target !== 'production') throw new Error('invalid_target');
      options.target = target;
    } else if (arg === '--offset') {
      options.offset = parseNonNegativeInteger(requireValue(args, ++index, arg), arg);
    } else if (arg === '--limit') {
      const limit = parseNonNegativeInteger(requireValue(args, ++index, arg), arg);
      if (limit < 1) throw new Error('limit_must_be_positive');
      if (limit > 500) throw new Error('limit_must_not_exceed_500');
      options.limit = limit;
    } else if (arg === '--concurrency') {
      const concurrency = parseNonNegativeInteger(requireValue(args, ++index, arg), arg);
      if (concurrency < 1 || concurrency > 4)
        throw new Error('concurrency_must_be_between_1_and_4');
      options.concurrency = concurrency;
    } else {
      throw new Error(`unknown_argument:${arg ?? ''}`);
    }
  }
  if (!options.input) throw new Error('missing_required_argument:--input');
  options.input = resolveCliPath(options.input);
  if (options.manifest) options.manifest = resolveCliPath(options.manifest);
  return options;
}

function resolveCliPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env.INIT_CWD || process.cwd(), path);
}

function requireValue(args: string[], index: number, argument: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`missing_argument_value:${argument}`);
  return value;
}

function parseNonNegativeInteger(value: string, argument: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid_integer:${argument}`);
  return parsed;
}
