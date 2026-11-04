import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  createCharacter,
  deleteCharacterLayoutRelease,
  discardCharacterLayoutDraft,
  getCharacterLayout,
  getCharacters,
  listCharacterLayoutReleases,
  publishCharacterLayoutDraft,
  rollbackCharacterLayoutRelease,
  saveCharacterLayoutDraft,
  uploadCharacterAvatar,
  type CharacterCard,
  type CharacterLayoutSnapshot,
  type CharacterLayoutValue,
} from '@miniapp/admin-client';
import { withReadRetry } from '../client';
import {
  intOption,
  listPositional,
  requiredPositional,
  stringOption,
  type CommandInput,
  type CommandSpec,
  type Ctx,
} from '../command';
import { CliError } from '../errors';
import { table } from '../output';

/**
 * 角色上下架、删除、排序都走“布局草稿 → 发布”，与网页角色卡页一致；
 * 数据库里早期的 set_character_enabled / reorder_characters 等 RPC 网页已不用，CLI 也不暴露。
 */

type LayoutStatus = 'listed' | 'delisted' | 'deleted' | 'unassigned';

function statusIn(layout: CharacterLayoutValue, id: string): LayoutStatus {
  if (layout.listed_ids.includes(id)) return 'listed';
  if (layout.delisted_ids.includes(id)) return 'delisted';
  if (layout.deleted_ids.includes(id)) return 'deleted';
  return 'unassigned';
}

const STATUS_LABEL: Record<LayoutStatus, string> = {
  listed: '上架',
  delisted: '下架',
  deleted: '已删除',
  unassigned: '未编排',
};

function workingLayout(snapshot: CharacterLayoutSnapshot): CharacterLayoutValue {
  const source = snapshot.draft ?? snapshot.published;
  return {
    listed_ids: [...source.listed_ids],
    delisted_ids: [...source.delisted_ids],
    deleted_ids: [...source.deleted_ids],
  };
}

async function loadAll(client: SupabaseClient) {
  return withReadRetry(() => Promise.all([getCharacters(client), getCharacterLayout(client)]));
}

function cardRow(card: CharacterCard, snapshot: CharacterLayoutSnapshot) {
  const published = statusIn(snapshot.published, card.id);
  const position = snapshot.published.listed_ids.indexOf(card.id);
  return {
    id: card.id,
    name: card.name,
    creator: card.creator,
    status: published,
    status_label: STATUS_LABEL[published],
    position: position >= 0 ? position + 1 : null,
    draft_status: snapshot.draft ? statusIn(snapshot.draft, card.id) : null,
    archived: card.archived_at !== null,
    updated_at: card.updated_at,
  };
}

/** 布局差异：谁进出了哪个列表、上架顺序是否变化。 */
function layoutDiff(
  before: CharacterLayoutValue,
  after: CharacterLayoutValue,
  names: Map<string, string>
) {
  const named = (id: string) => ({ id, name: names.get(id) ?? null });
  const moved: Array<{ id: string; name: string | null; from: LayoutStatus; to: LayoutStatus }> =
    [];
  for (const id of new Set([
    ...before.listed_ids,
    ...before.delisted_ids,
    ...before.deleted_ids,
    ...after.listed_ids,
    ...after.delisted_ids,
    ...after.deleted_ids,
  ])) {
    const from = statusIn(before, id);
    const to = statusIn(after, id);
    if (from !== to) moved.push({ ...named(id), from, to });
  }
  const orderChanged =
    before.listed_ids.filter((id) => after.listed_ids.includes(id)).join(',') !==
    after.listed_ids.filter((id) => before.listed_ids.includes(id)).join(',');
  return {
    moved,
    listed_order_changed: orderChanged,
    listed_after: after.listed_ids.map((id, index) => ({ position: index + 1, ...named(id) })),
  };
}

function formatLayoutDiff(diff: ReturnType<typeof layoutDiff>): string {
  const lines = diff.moved.map(
    (entry) =>
      `  ${entry.name ?? entry.id}：${STATUS_LABEL[entry.from]} → ${STATUS_LABEL[entry.to]}`
  );
  if (diff.listed_order_changed) lines.push('  上架顺序有变化');
  if (lines.length === 0) return '（无差异）';
  return [
    ...lines,
    '上架顺序：',
    ...diff.listed_after.map((row) => `  ${row.position}. ${row.name ?? row.id}`),
  ].join('\n');
}

function requireKnownIds(ids: string[], cards: CharacterCard[]): void {
  const known = new Set(cards.map((card) => card.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new CliError('not_found', `角色不存在：${missing.join(', ')}`);
}

/** 把一组角色移到目标列表；上架时可指定从第几位开始插入（1 起）。 */
export function moveIds(
  layout: CharacterLayoutValue,
  ids: string[],
  to: Exclude<LayoutStatus, 'unassigned'>,
  position?: number
): CharacterLayoutValue {
  const strip = (list: string[]) => list.filter((id) => !ids.includes(id));
  const next = {
    listed_ids: strip(layout.listed_ids),
    delisted_ids: strip(layout.delisted_ids),
    deleted_ids: strip(layout.deleted_ids),
  };
  if (to === 'listed') {
    const index =
      position === undefined
        ? next.listed_ids.length
        : Math.min(position - 1, next.listed_ids.length);
    next.listed_ids.splice(index, 0, ...ids);
  } else if (to === 'delisted') {
    next.delisted_ids.push(...ids);
  } else {
    next.deleted_ids.push(...ids);
  }
  return next;
}

/** 在当前草稿（没有则以线上布局为底）上做修改并保存，返回保存后的差异。 */
async function editLayout(
  ctx: Ctx,
  action: string,
  edit: (layout: CharacterLayoutValue, cards: CharacterCard[]) => CharacterLayoutValue
) {
  const { client } = await ctx.auth();
  const [cards, snapshot] = await loadAll(client);
  const next = edit(workingLayout(snapshot), cards);
  const names = new Map(cards.map((card) => [card.id, card.name]));
  const diff = layoutDiff(snapshot.published, next, names);
  await ctx.confirm({ action, human: formatLayoutDiff(diff), preview: diff });
  const draft = await saveCharacterLayoutDraft(client, next, snapshot.layout_version);
  return {
    data: { saved: true, draft_id: draft.id, base_layout_version: draft.base_layout_version, diff },
    human: `布局草稿已保存（尚未生效）\n${formatLayoutDiff(diff)}\n下一步：pnpm admin layout publish`,
  };
}

const LayoutFileSchema = z
  .object({
    listed_ids: z.array(z.string().min(1)),
    delisted_ids: z.array(z.string().min(1)),
    deleted_ids: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    const all = [...value.listed_ids, ...value.delisted_ids, ...value.deleted_ids];
    const duplicates = all.filter((id, index) => all.indexOf(id) !== index);
    if (duplicates.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `角色重复出现在多个位置：${[...new Set(duplicates)].join(', ')}`,
      });
    }
  });

const CharacterInputSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().default(''),
    avatar_url: z.string().default(''),
    tags: z.array(z.string()).default([]),
    creator: z.string().default(''),
    first_mes: z.string().default(''),
    creator_notes: z.string().default(''),
    personality: z.string().default(''),
    scenario: z.string().default(''),
    system_prompt: z.string().default(''),
    mes_example: z.string().default(''),
  })
  .strict();

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(ctx: Ctx, path: string): string {
  const bytes = ctx.readBytes(path);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new CliError('validation_failed', `${path} 不是 PNG 文件`);
  return bytes.toString('base64');
}

const idsArg = [{ name: 'ids', description: '角色 id（可多个）', required: true, variadic: true }];

function idList(input: CommandInput): string[] {
  const ids = listPositional(input, 'ids');
  if (ids.length === 0) throw new CliError('usage', '至少需要一个角色 id');
  return [...new Set(ids)];
}

export const characterCommands: CommandSpec[] = [
  {
    name: 'character list',
    summary: '角色列表：线上上下架状态、上架位置、草稿中的状态',
    write: false,
    options: {
      query: { type: 'string', description: '按名称/作者/id 过滤' },
      status: { type: 'string', description: 'listed | delisted | deleted | unassigned' },
    },
    async run(ctx, input) {
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      const query = stringOption(input, 'query')?.toLowerCase();
      const status = stringOption(input, 'status');
      const rows = cards
        .map((card) => cardRow(card, snapshot))
        .filter(
          (row) =>
            !query || [row.id, row.name, row.creator].some((v) => v.toLowerCase().includes(query))
        )
        .filter((row) => !status || row.status === status)
        .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
      return {
        data: {
          layout_version: snapshot.layout_version,
          has_draft: snapshot.draft !== null,
          characters: rows,
        },
        human: table(rows, ['position', 'status_label', 'name', 'creator', 'draft_status', 'id']),
      };
    },
  },
  {
    name: 'character get',
    summary: '角色详情',
    write: false,
    positionals: [{ name: 'id', description: '角色 id', required: true }],
    async run(ctx, input) {
      const id = requiredPositional(input, 'id');
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      const card = cards.find((row) => row.id === id);
      if (!card) throw new CliError('not_found', `角色不存在：${id}`);
      const data = { ...card, layout: cardRow(card, snapshot) };
      return { data };
    },
  },
  {
    name: 'character create',
    summary: '新建角色（新建后默认不上架，需 layout list + layout publish）',
    write: true,
    options: {
      file: {
        type: 'string',
        description:
          '角色 JSON：name 必填，其余 description/tags/creator/first_mes/creator_notes/personality/scenario/system_prompt/mes_example/avatar_url 可选',
      },
      avatar: { type: 'string', description: '同时上传头像 PNG' },
    },
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      if (!file) throw new CliError('usage', '需要 --file');
      const parsed = CharacterInputSchema.safeParse(ctx.readJsonFile(file));
      if (!parsed.success) {
        throw new CliError('validation_failed', '角色资料未通过校验，没有提交', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const avatarPath = stringOption(input, 'avatar');
      const avatar = avatarPath ? readPng(ctx, avatarPath) : null;
      const card = parsed.data;
      await ctx.confirm({
        action: `新建角色「${card.name}」${avatar ? '并上传头像' : ''}`,
        human: JSON.stringify(card, null, 2),
        preview: card,
      });
      const { client, config } = await ctx.auth();
      const created = await createCharacter(client, {
        name: card.name,
        description: card.description,
        avatarUrl: card.avatar_url,
        tags: card.tags,
        creator: card.creator,
        firstMes: card.first_mes,
        creatorNotes: card.creator_notes,
        personality: card.personality,
        scenario: card.scenario,
        systemPrompt: card.system_prompt,
        mesExample: card.mes_example,
      });
      const avatarUrl = avatar
        ? await uploadCharacterAvatar(client, config.apiUrl, created.id, avatar)
        : null;
      return {
        data: { ...created, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) },
        human: `已新建角色 ${created.name}（${created.id}），尚未上架。\n上架：pnpm admin layout list ${created.id} && pnpm admin layout publish`,
      };
    },
  },
  {
    name: 'character avatar',
    summary: '上传/替换角色头像（PNG）',
    write: true,
    positionals: [
      { name: 'id', description: '角色 id', required: true },
      { name: 'png', description: 'PNG 文件路径', required: true },
    ],
    async run(ctx, input) {
      const id = requiredPositional(input, 'id');
      const png = readPng(ctx, requiredPositional(input, 'png'));
      const { client, config } = await ctx.auth();
      const [cards] = await loadAll(client);
      const card = cards.find((row) => row.id === id);
      if (!card) throw new CliError('not_found', `角色不存在：${id}`);
      await ctx.confirm({
        action: `替换「${card.name}」的头像`,
        human: `角色：${card.name}（${id}）`,
        preview: { id },
      });
      const avatarUrl = await uploadCharacterAvatar(client, config.apiUrl, id, png);
      return { data: { id, avatar_url: avatarUrl }, human: `头像已更新：${avatarUrl}` };
    },
  },
  {
    name: 'layout get',
    summary: '角色布局：线上与草稿的上架/下架/删除列表',
    write: false,
    async run(ctx) {
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      const names = new Map(cards.map((card) => [card.id, card.name]));
      const withNames = (layout: CharacterLayoutValue) => ({
        listed: layout.listed_ids.map((id, index) => ({
          position: index + 1,
          id,
          name: names.get(id) ?? null,
        })),
        delisted: layout.delisted_ids.map((id) => ({ id, name: names.get(id) ?? null })),
        deleted: layout.deleted_ids.map((id) => ({ id, name: names.get(id) ?? null })),
      });
      const data = {
        layout_version: snapshot.layout_version,
        published: withNames(snapshot.published),
        draft: snapshot.draft
          ? {
              id: snapshot.draft.id,
              updated_at: snapshot.draft.updated_at,
              ...withNames(snapshot.draft),
            }
          : null,
        draft_diff: snapshot.draft ? layoutDiff(snapshot.published, snapshot.draft, names) : null,
      };
      return {
        data,
        human: [
          `布局版本 ${snapshot.layout_version}　上架 ${data.published.listed.length}　下架 ${data.published.delisted.length}　删除 ${data.published.deleted.length}`,
          ...data.published.listed.map((row) => `  ${row.position}. ${row.name ?? row.id}`),
          data.draft_diff ? `草稿改动：\n${formatLayoutDiff(data.draft_diff)}` : '没有草稿',
        ].join('\n'),
      };
    },
  },
  {
    name: 'layout list',
    summary: '把角色加入上架列表（保存到布局草稿）',
    write: true,
    positionals: idsArg,
    options: { position: { type: 'string', description: '从第几位插入（1 起），默认放最后' } },
    async run(ctx, input) {
      const ids = idList(input);
      const position =
        stringOption(input, 'position') === undefined
          ? undefined
          : intOption(input, 'position', 1, 10_000);
      return editLayout(ctx, `上架 ${ids.length} 个角色`, (layout, cards) => {
        requireKnownIds(ids, cards);
        return moveIds(layout, ids, 'listed', position);
      });
    },
  },
  {
    name: 'layout delist',
    summary: '把角色下架（保存到布局草稿）',
    write: true,
    positionals: idsArg,
    async run(ctx, input) {
      const ids = idList(input);
      return editLayout(ctx, `下架 ${ids.length} 个角色`, (layout, cards) => {
        requireKnownIds(ids, cards);
        return moveIds(layout, ids, 'delisted');
      });
    },
  },
  {
    name: 'layout delete',
    summary: '把角色移入已删除（保存到布局草稿）',
    write: true,
    positionals: idsArg,
    async run(ctx, input) {
      const ids = idList(input);
      return editLayout(ctx, `删除 ${ids.length} 个角色`, (layout, cards) => {
        requireKnownIds(ids, cards);
        return moveIds(layout, ids, 'deleted');
      });
    },
  },
  {
    name: 'layout move',
    summary: '调整已上架角色的位置（保存到布局草稿）',
    write: true,
    positionals: [{ name: 'id', description: '角色 id', required: true }],
    options: { position: { type: 'string', description: '目标位置（1 起）' } },
    async run(ctx, input) {
      const id = requiredPositional(input, 'id');
      if (stringOption(input, 'position') === undefined)
        throw new CliError('usage', '需要 --position');
      const position = intOption(input, 'position', 1, 10_000);
      return editLayout(ctx, `移动角色到第 ${position} 位`, (layout) => {
        if (!layout.listed_ids.includes(id))
          throw new CliError('not_found', `角色不在上架列表：${id}`);
        return moveIds(layout, [id], 'listed', position);
      });
    },
  },
  {
    name: 'layout draft set',
    summary: '用完整布局文件覆盖布局草稿',
    write: true,
    options: {
      file: { type: 'string', description: 'JSON：{ listed_ids, delisted_ids, deleted_ids }' },
    },
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      if (!file) throw new CliError('usage', '需要 --file');
      const parsed = LayoutFileSchema.safeParse(ctx.readJsonFile(file));
      if (!parsed.success) {
        throw new CliError('validation_failed', '布局文件未通过校验，没有提交', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const next = parsed.data;
      return editLayout(ctx, '覆盖角色布局草稿', (_layout, cards) => {
        requireKnownIds([...next.listed_ids, ...next.delisted_ids, ...next.deleted_ids], cards);
        return next;
      });
    },
  },
  {
    name: 'layout diff',
    summary: '比较布局草稿与线上布局',
    write: false,
    async run(ctx) {
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      if (!snapshot.draft) return { data: { has_draft: false }, human: '没有草稿' };
      const diff = layoutDiff(
        snapshot.published,
        snapshot.draft,
        new Map(cards.map((c) => [c.id, c.name]))
      );
      return { data: { has_draft: true, diff }, human: formatLayoutDiff(diff) };
    },
  },
  {
    name: 'layout publish',
    summary: '发布布局草稿，立即在生产生效',
    write: true,
    async run(ctx) {
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      if (!snapshot.draft) throw new CliError('not_found', '没有布局草稿');
      const diff = layoutDiff(
        snapshot.published,
        snapshot.draft,
        new Map(cards.map((c) => [c.id, c.name]))
      );
      await ctx.confirm({
        action: '发布角色布局，立即在生产生效',
        human: formatLayoutDiff(diff),
        preview: diff,
      });
      const version = await publishCharacterLayoutDraft(client, snapshot.draft.id);
      return { data: { layout_version: version, diff }, human: `已发布，布局版本 ${version}` };
    },
  },
  {
    name: 'layout discard',
    summary: '放弃布局草稿',
    write: true,
    async run(ctx) {
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      if (!snapshot.draft) return { data: { discarded: false }, human: '没有草稿' };
      const diff = layoutDiff(
        snapshot.published,
        snapshot.draft,
        new Map(cards.map((c) => [c.id, c.name]))
      );
      await ctx.confirm({
        action: '放弃角色布局草稿',
        human: formatLayoutDiff(diff),
        preview: diff,
      });
      await discardCharacterLayoutDraft(client, snapshot.draft.id);
      return { data: { discarded: true }, human: '布局草稿已放弃' };
    },
  },
  {
    name: 'layout releases',
    summary: '布局发布历史',
    write: false,
    options: { limit: { type: 'string', description: '条数，默认 20，最多 100' } },
    async run(ctx, input) {
      const { client } = await ctx.auth();
      const releases = await withReadRetry(() =>
        listCharacterLayoutReleases(client, intOption(input, 'limit', 20, 100))
      );
      const rows = releases.map((release) => ({
        release_id: release.id,
        layout_version: release.layout_version,
        kind: release.release_kind,
        listed: release.listed_count,
        delisted: release.delisted_count,
        deleted: release.deleted_count,
        released_by: release.released_by_name ?? release.released_by_email,
        released_at: release.released_at,
      }));
      return {
        data: rows,
        human: table(rows, [
          'released_at',
          'layout_version',
          'kind',
          'listed',
          'released_by',
          'release_id',
        ]),
      };
    },
  },
  {
    name: 'layout rollback',
    summary: '把布局恢复到某次发布（会生成新版本）',
    write: true,
    positionals: [
      { name: 'release-id', description: '布局发布 id（见 layout releases）', required: true },
    ],
    async run(ctx, input) {
      const releaseId = requiredPositional(input, 'release-id');
      const { client } = await ctx.auth();
      const [cards, snapshot] = await loadAll(client);
      const releases = await withReadRetry(() => listCharacterLayoutReleases(client, 100));
      const target = releases.find((release) => release.id === releaseId);
      if (!target) throw new CliError('not_found', '布局发布记录不存在（只查最近 100 条）');
      const diff = layoutDiff(
        snapshot.published,
        target,
        new Map(cards.map((c) => [c.id, c.name]))
      );
      await ctx.confirm({
        action: `回滚角色布局到版本 ${target.layout_version}，立即在生产生效`,
        human: formatLayoutDiff(diff),
        preview: diff,
      });
      const version = await rollbackCharacterLayoutRelease(
        client,
        releaseId,
        snapshot.layout_version
      );
      return { data: { layout_version: version, diff }, human: `已回滚，布局版本 ${version}` };
    },
  },
  {
    name: 'layout delete-release',
    summary: '删除一条布局历史版本（不影响线上布局）',
    write: true,
    positionals: [{ name: 'release-id', description: '布局发布 id', required: true }],
    async run(ctx, input) {
      const releaseId = requiredPositional(input, 'release-id');
      const { client } = await ctx.auth();
      await ctx.confirm({
        action: `删除布局历史版本 ${releaseId}`,
        human: '只删除历史记录，不影响线上布局',
        preview: { release_id: releaseId },
      });
      await deleteCharacterLayoutRelease(client, releaseId);
      return { data: { deleted: true, release_id: releaseId }, human: '历史版本已删除' };
    },
  },
];
