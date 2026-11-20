import { existsSync, renameSync, writeFileSync } from 'node:fs';
import {
  AdminStatusBarApiError,
  fetchCharacterStatusBar,
  fetchTopFavoritedCards,
  generateCharacterStatusBar,
  setCharacterStatusBar,
} from '@miniapp/admin-client';
import {
  ADMIN_STATUS_BAR_DEFAULT_MODEL,
  ADMIN_STATUS_BAR_TOP_MAX,
  StatusBarTemplateDraftSchema,
  checkStatusBarTemplate,
  statusDefinitionText,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { z } from 'zod';
import { withReadRetry } from '../client';
import {
  intOption,
  listPositional,
  requiredPositional,
  stringOption,
  type CommandSpec,
  type Ctx,
} from '../command';
import { CliError } from '../errors';
import { note, table } from '../output';

/**
 * 给存量卡生成状态栏：top 看收藏量头部 → generate 生成到本地文件（不改线上，可断点续跑）
 * → 抽查 → apply 把文件写进卡（先看差异，再 --yes）。
 */

const ResultSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  favoriteCount: z.number().nullable(),
  model: z.string(),
  template: StatusBarTemplateDraftSchema.nullable(),
  error: z.string().nullable(),
  durationMs: z.number().nullable(),
});
type GenerateResult = z.infer<typeof ResultSchema>;
const ResultFileSchema = z.object({ results: z.array(ResultSchema) });

const itemNames = (template: StatusBarTemplate) =>
  template.sections.flatMap((section) => section.items.map((item) => item.name));

function summary(template: StatusBarTemplate | null): string {
  if (!template) return '（没有）';
  const names = itemNames(template);
  return `${names.length} 项：${names.join('、')}`;
}

function readResults(ctx: Ctx, path: string): GenerateResult[] {
  const parsed = ResultFileSchema.safeParse(ctx.readJsonFile(path));
  if (!parsed.success)
    throw new CliError('validation_failed', `${path} 不是 generate 输出的结果文件`);
  return parsed.data.results;
}

/** 每张卡写完就落盘（先写临时文件再改名），中途断了重跑会跳过已成功的卡。 */
function saveResults(path: string, results: GenerateResult[]): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ results }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

async function mapLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** 模型偶尔超时/不可用：同一张卡最多再试一次，间隔几秒；格式不合格（422）后端已重试过，不再试。 */
async function generateOnce(
  run: () => ReturnType<typeof generateCharacterStatusBar>
): ReturnType<typeof generateCharacterStatusBar> {
  try {
    return await run();
  } catch (error) {
    const retryable =
      error instanceof AdminStatusBarApiError &&
      (error.status === 503 || error.status === 429 || error.code === 'TIMEOUT');
    if (!retryable) throw error;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return run();
  }
}

export const statusBarCommands: CommandSpec[] = [
  {
    name: 'status-bar top',
    summary: '状态栏：按收藏量从高到低列卡，看哪些已有状态栏',
    write: false,
    options: {
      limit: {
        type: 'string',
        description: `前多少张（默认 300，最多 ${ADMIN_STATUS_BAR_TOP_MAX}）`,
      },
    },
    async run(ctx, input) {
      const limit = intOption(input, 'limit', 300, ADMIN_STATUS_BAR_TOP_MAX);
      const { client, config } = await ctx.auth();
      const cards = await withReadRetry(() => fetchTopFavoritedCards(client, config.apiUrl, limit));
      const rows = cards.map((card, index) => ({
        rank: index + 1,
        favorites: card.favoriteCount,
        status_bar: card.hasStatusBar ? '有' : '—',
        name: card.name,
        id: card.characterId,
      }));
      const missing = cards.filter((card) => !card.hasStatusBar).length;
      return {
        data: { cards },
        human: `${table(rows, ['rank', 'favorites', 'status_bar', 'name', 'id'])}\n共 ${cards.length} 张，其中 ${missing} 张还没有状态栏`,
      };
    },
  },
  {
    name: 'status-bar get',
    summary: '状态栏：看一张卡上现有的状态栏（规则原文，和状态模型看到的一样）',
    write: false,
    positionals: [{ name: 'id', description: '角色 id', required: true }],
    async run(ctx, input) {
      const id = requiredPositional(input, 'id');
      const { client, config } = await ctx.auth();
      const data = await withReadRetry(() => fetchCharacterStatusBar(client, config.apiUrl, id));
      return {
        data,
        human: data.template
          ? `${data.name}\n\n${statusDefinitionText(data.template)}`
          : `${data.name}：卡上没有状态栏`,
      };
    },
  },
  {
    name: 'status-bar generate',
    summary:
      '状态栏：给收藏量前 N 张（或指定的）卡生成状态栏，结果写到本地文件，不改线上；重跑会跳过已成功的卡',
    write: false,
    positionals: [
      {
        name: 'ids',
        description: '角色 id（可多个；不填就用 --top）',
        required: false,
        variadic: true,
      },
    ],
    options: {
      top: { type: 'string', description: '收藏量前多少张（默认 300）' },
      out: { type: 'string', description: '结果文件（默认 status-bar-results.json）' },
      model: { type: 'string', description: `生成模型（默认 ${ADMIN_STATUS_BAR_DEFAULT_MODEL}）` },
      concurrency: { type: 'string', description: '同时生成几张（默认 3，最多 20）' },
      'include-existing': { type: 'boolean', description: '卡上已有状态栏的也重新生成' },
    },
    examples: [
      'pnpm admin status-bar generate --top 300 --out status-bar-top300.json',
      'pnpm admin status-bar generate <id> --out one.json',
    ],
    async run(ctx, input) {
      const out = ctx.resolvePath(stringOption(input, 'out') ?? 'status-bar-results.json');
      const model = stringOption(input, 'model') ?? ADMIN_STATUS_BAR_DEFAULT_MODEL;
      const concurrency = intOption(input, 'concurrency', 3, 20);
      const { client, config } = await ctx.auth();
      const ids = listPositional(input, 'ids');
      const top = await withReadRetry(() =>
        fetchTopFavoritedCards(
          client,
          config.apiUrl,
          ids.length
            ? ADMIN_STATUS_BAR_TOP_MAX
            : intOption(input, 'top', 300, ADMIN_STATUS_BAR_TOP_MAX)
        )
      );
      const byId = new Map(top.map((card) => [card.characterId, card]));
      const targets = ids.length
        ? ids.map((id) => ({
            characterId: id,
            favoriteCount: byId.get(id)?.favoriteCount ?? null,
            hasStatusBar: byId.get(id)?.hasStatusBar ?? false,
          }))
        : top;
      const previous = existsSync(out) ? readResults(ctx, out) : [];
      const done = new Map(previous.filter((r) => r.template).map((r) => [r.characterId, r]));
      const results = new Map<string, GenerateResult>(previous.map((r) => [r.characterId, r]));
      const todo = targets.filter(
        (card) =>
          !done.has(card.characterId) &&
          (input.options['include-existing'] === true || !card.hasStatusBar)
      );
      note(
        `目标 ${targets.length} 张，已成功 ${done.size} 张，这次生成 ${todo.length} 张（${model}，并发 ${concurrency}）`
      );
      let finished = 0;
      await mapLimited(todo, concurrency, async (card) => {
        let result: GenerateResult;
        try {
          const data = await generateOnce(() =>
            generateCharacterStatusBar(client, config.apiUrl, card.characterId, model)
          );
          result = { ...data, favoriteCount: card.favoriteCount, error: null };
        } catch (error) {
          result = {
            characterId: card.characterId,
            name: byId.get(card.characterId)?.name ?? card.characterId,
            favoriteCount: card.favoriteCount,
            model,
            template: null,
            error: error instanceof Error ? error.message : String(error),
            durationMs: null,
          };
        }
        results.set(card.characterId, result);
        saveResults(out, [...results.values()]);
        finished += 1;
        note(
          `[${finished}/${todo.length}] ${result.name}：${result.template ? summary(result.template) : `失败：${result.error}`}`
        );
      });
      const all = [...results.values()];
      const failed = all.filter((r) => !r.template);
      return {
        data: {
          out,
          total: all.length,
          succeeded: all.length - failed.length,
          failed: failed.map((r) => ({ id: r.characterId, name: r.name, error: r.error })),
        },
        human: `结果在 ${out}：成功 ${all.length - failed.length} 张，失败 ${failed.length} 张${failed.length ? '（重跑同一命令只补失败的）' : ''}\n下一步：pnpm admin status-bar apply --file ${out}`,
      };
    },
  },
  {
    name: 'status-bar apply',
    summary: '状态栏：把 generate 的结果写进卡（默认跳过卡上已有状态栏的）',
    write: true,
    options: {
      file: { type: 'string', description: 'generate 输出的结果文件' },
      overwrite: { type: 'boolean', description: '卡上已有状态栏的也覆盖' },
    },
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      if (!file) throw new CliError('usage', '需要 --file');
      const generated = readResults(ctx, file).filter(
        (r): r is GenerateResult & { template: StatusBarTemplate } =>
          r.template !== null && checkStatusBarTemplate(r.template).length === 0
      );
      if (!generated.length) throw new CliError('validation_failed', '文件里没有可写入的结果');
      const { client, config } = await ctx.auth();
      // 逐张读卡上现有的（不靠排行榜，指定 id 的卡不在头部也能判断），已有的默认跳过。
      const existing = new Set<string>();
      await mapLimited(generated, 6, async (r) => {
        const data = await withReadRetry(() =>
          fetchCharacterStatusBar(client, config.apiUrl, r.characterId)
        );
        if (data.template) existing.add(r.characterId);
      });
      const overwrite = input.options.overwrite === true;
      const plan = generated.filter((r) => overwrite || !existing.has(r.characterId));
      const skipped = generated.length - plan.length;
      await ctx.confirm({
        action: `给 ${plan.length} 张卡写入状态栏${skipped ? `（跳过 ${skipped} 张已有的）` : ''}`,
        human: plan
          .map(
            (r) =>
              `${r.name}（收藏 ${r.favoriteCount ?? '?'}）${existing.has(r.characterId) ? '［覆盖］' : ''}\n    ${summary(r.template)}`
          )
          .join('\n'),
        preview: plan.map((r) => ({
          id: r.characterId,
          name: r.name,
          overwrite: existing.has(r.characterId),
          items: itemNames(r.template),
        })),
      });
      const written: Array<{ id: string; name: string; draftPatched: boolean }> = [];
      const failed: Array<{ id: string; name: string; error: string }> = [];
      for (const r of plan) {
        try {
          const data = await setCharacterStatusBar(
            client,
            config.apiUrl,
            r.characterId,
            r.template
          );
          written.push({ id: r.characterId, name: r.name, draftPatched: data.draftPatched });
        } catch (error) {
          failed.push({
            id: r.characterId,
            name: r.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const patched = written.filter((w) => w.draftPatched).length;
      return {
        data: { written, failed, skipped },
        human: `已写入 ${written.length} 张${patched ? `（其中 ${patched} 张创作卡一并补进了作者草稿）` : ''}，失败 ${failed.length} 张${failed.length ? `：\n${failed.map((f) => `  ${f.name}：${f.error}`).join('\n')}` : ''}`,
      };
    },
  },
];
