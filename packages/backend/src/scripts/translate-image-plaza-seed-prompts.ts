import '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  closeSeedPromptTranslateResources,
  countCivitaiSeedPromptTranslatePending,
  listCivitaiSeedWorksForPromptTranslate,
  translateAndStoreSeedPrompt,
} from '../features/image-plaza/seed-prompt-translate.js';
import { createLogger } from '../lib/logger.js';
import { config } from '../platform/config.js';

interface CliOptions {
  apply: boolean;
  target?: 'test' | 'production';
  force: boolean;
  untilDone: boolean;
  offset: number;
  limit?: number;
  concurrency: number;
}

const log = createLogger('image-plaza-seed-prompt-translate');
let exitCode = 0;

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.apply) assertApplyGates(options);

  if (options.untilDone) {
    if (!options.apply) throw new Error('until_done_requires_apply');
    if (options.limit === undefined) options.limit = 100;
    let round = 0;
    while (true) {
      round += 1;
      const stats = await countCivitaiSeedPromptTranslatePending();
      console.log(
        `round=${round} total=${stats.total} translated=${stats.translated} failed=${stats.failed} pending=${stats.pending}`
      );
      if (stats.pending === 0) {
        console.log('Image plaza seed prompt translate until-done: pending=0');
        break;
      }

      const batch = await runBatch({
        ...options,
        offset: 0,
        limit: options.limit,
      });
      console.log(
        `round=${round} batch complete: translated=${batch.translated} skipped=${batch.skipped} failed=${batch.failed} marked=${batch.marked}`
      );
      // 本批既无成功也无标记失败，说明卡在可重试传输错误，停止避免空转。
      if (batch.translated === 0 && batch.marked === 0 && batch.failed > 0) {
        throw new Error('until_done_stalled_on_retryable_failures');
      }
      await sleep(500);
    }
  } else {
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
    if (options.apply) {
      const batch = await runBatch({ ...options, rows: pending });
      console.log(
        `Image plaza seed prompt translate complete: translated=${batch.translated} skipped=${batch.skipped} failed=${batch.failed} marked=${batch.marked}`
      );
      if (batch.failed > 0) exitCode = 1;
    }
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
    await closeSeedPromptTranslateResources();
  } catch (err) {
    log.sys.error(
      { event: 'image_plaza.seed_prompt.cleanup_failed', err },
      '种子提示词翻译资源清理失败'
    );
    exitCode = 1;
  }
}

process.exitCode = exitCode;

async function runBatch(input: CliOptions & { rows?: Awaited<ReturnType<typeof listCivitaiSeedWorksForPromptTranslate>> }): Promise<{
  translated: number;
  skipped: number;
  failed: number;
  marked: number;
}> {
  const pending =
    input.rows ??
    (await listCivitaiSeedWorksForPromptTranslate({
      offset: input.offset,
      limit: input.limit ?? 100,
      pendingOnly: true,
    }));

  let translated = 0;
  let skipped = 0;
  let failed = 0;
  let marked = 0;
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
          force: input.force,
        });
        if (status === 'translated') translated += 1;
        else if (status === 'skipped_existing') skipped += 1;
        else if (status === 'failed_marked' || status === 'failed_over_limit') {
          marked += 1;
          log.sys.warn(
            {
              event: 'image_plaza.seed_prompt.translate_item_marked_failed',
              workId: row.id,
              status,
            },
            '种子提示词翻译标记失败'
          );
        } else {
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
      if (nextIndex < pending.length) await sleep(150);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(input.concurrency, Math.max(pending.length, 1)) }, () => worker())
  );
  return { translated, skipped, failed, marked };
}

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
  if (!options.untilDone && options.limit === undefined) {
    throw new Error('apply_requires_explicit_batch_limit');
  }
  const preferDeepseek = process.env.IMAGE_PLAZA_TRANSLATE_PROVIDER === 'deepseek';
  if (preferDeepseek) {
    if (!config.voice.draft.apiKey) throw new Error('deepseek_api_key_missing');
  } else if (!config.imagePlaza.apiKey && !config.voice.draft.apiKey) {
    throw new Error('translate_provider_api_key_missing');
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    force: false,
    untilDone: false,
    offset: 0,
    concurrency: 1,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--until-done') options.untilDone = true;
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
