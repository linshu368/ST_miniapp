import '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  listCivitaiSeedWorksForPromptTranslate,
  translateAndStoreSeedPrompt,
} from '../features/image-plaza/seed-prompt-translate.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';

interface CliOptions {
  apply: boolean;
  target?: 'test' | 'production';
  force: boolean;
  offset: number;
  limit?: number;
  concurrency: number;
}

const log = createLogger('image-plaza-seed-prompt-translate');
let exitCode = 0;

try {
  const options = parseArgs(process.argv.slice(2));
  const rows = await listCivitaiSeedWorksForPromptTranslate({
    offset: options.offset,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const pending = rows.filter((row) => options.force || !row.promptZh);
  const already = rows.length - pending.length;

  console.log(
    [
      `Image plaza seed prompt translate ${options.apply ? 'apply' : 'dry-run'}:`,
      `selected=${rows.length}`,
      `pending=${pending.length}`,
      `already_translated=${already}`,
      `offset=${options.offset}`,
      `concurrency=${options.concurrency}`,
    ].join(' ')
  );

  if (!options.apply) {
    // dry-run only
  } else {
    assertApplyGates(options);
    let translated = 0;
    let skipped = 0;
    let failed = 0;
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < pending.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = pending[index];
        if (!row) return;
        try {
          const status = await translateAndStoreSeedPrompt({
            workId: row.id,
            force: options.force,
          });
          if (status === 'translated') translated += 1;
          else if (status === 'skipped_existing') skipped += 1;
          else {
            failed += 1;
            log.sys.warn(
              {
                event: 'image_plaza.seed_prompt.translate_item_failed',
                workId: row.id,
                status,
              },
              '种子提示词翻译条目失败'
            );
          }
        } catch (err) {
          failed += 1;
          log.sys.error(
            { event: 'image_plaza.seed_prompt.translate_item_failed', err, workId: row.id },
            '种子提示词翻译条目异常'
          );
        }
        if (nextIndex < pending.length) await sleep(200);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, Math.max(pending.length, 1)) }, () =>
        worker()
      )
    );

    console.log(
      `Image plaza seed prompt translate complete: translated=${translated} skipped=${skipped} failed=${failed}`
    );
    if (failed > 0) exitCode = 1;
  }
} catch (err) {
  log.sys.error(
    { event: 'image_plaza.seed_prompt.translate_failed', err },
    '种子提示词翻译任务失败'
  );
  console.error(err instanceof Error ? err.message : 'image_plaza_seed_prompt_translate_failed');
  exitCode = 1;
} finally {
  try {
    await closeSupabaseClient();
  } catch (err) {
    log.sys.error(
      { event: 'image_plaza.seed_prompt.cleanup_failed', err },
      '种子提示词翻译资源清理失败'
    );
    exitCode = 1;
  }
}

process.exitCode = exitCode;

function assertApplyGates(options: CliOptions): void {
  if (!options.target) throw new Error('apply_requires_explicit_target');
  if (options.target !== 'test') {
    throw new Error('apply_only_allows_target_test');
  }
  if (options.target !== config.database.target) {
    throw new Error(
      `apply_target_mismatch:requested=${options.target},configured=${config.database.target}`
    );
  }
  if (options.limit === undefined) throw new Error('apply_requires_explicit_batch_limit');
  if (!config.imagePlaza.apiKey) throw new Error('venice_api_key_missing');
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    force: false,
    offset: 0,
    concurrency: 1,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
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
      if (concurrency < 1 || concurrency > 4) {
        throw new Error('concurrency_must_be_between_1_and_4');
      }
      options.concurrency = concurrency;
    } else {
      throw new Error(`unknown_argument:${arg ?? ''}`);
    }
  }
  return options;
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
