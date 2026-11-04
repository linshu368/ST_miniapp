import {
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  listInviteRecords,
  setAnnouncementPublished,
  updateAnnouncement,
  uploadInvitePoster,
  INVITE_RECORDS_MAX_PAGE_SIZE,
  INVITE_RECORDS_PAGE_SIZE,
  type Announcement,
  type AnnouncementCategory,
} from '@miniapp/admin-client';
import { withReadRetry } from '../client';
import {
  intOption,
  requiredPositional,
  stringOption,
  type CommandInput,
  type CommandSpec,
  type Ctx,
} from '../command';
import { diffValues, formatDiff } from '../diff';
import { CliError } from '../errors';
import { table } from '../output';

const CATEGORIES: readonly AnnouncementCategory[] = [
  'announcement',
  'activity',
  'system',
  'interaction',
];

function category(raw: string | undefined, fallback?: AnnouncementCategory): AnnouncementCategory {
  if (raw === undefined && fallback) return fallback;
  if (raw && (CATEGORIES as readonly string[]).includes(raw)) return raw as AnnouncementCategory;
  throw new CliError('usage', `--category 必须是 ${CATEGORIES.join(' | ')}`);
}

function body(ctx: Ctx, input: CommandInput): string | undefined {
  const file = stringOption(input, 'body-file');
  const text = stringOption(input, 'body');
  if (file !== undefined && text !== undefined)
    throw new CliError('usage', '--body 与 --body-file 只能二选一');
  return file !== undefined ? ctx.readText(file) : text;
}

function sortOrder(input: CommandInput, fallback: number): number {
  const raw = stringOption(input, 'sort-order');
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new CliError('usage', '--sort-order 必须是整数');
  return value;
}

async function findAnnouncement(ctx: Ctx, id: string): Promise<Announcement> {
  const { client } = await ctx.auth();
  const all = await withReadRetry(() => listAnnouncements(client));
  const found = all.find((row) => row.id === id);
  if (!found) throw new CliError('not_found', `公告不存在：${id}`);
  return found;
}

const contentOptions = {
  category: { type: 'string', description: 'announcement | activity | system | interaction' },
  title: { type: 'string', description: '标题' },
  body: { type: 'string', description: '正文' },
  'body-file': { type: 'string', description: '从文件读取正文' },
  'sort-order': { type: 'string', description: '排序（整数，越小越靠前）' },
} as const;

const IMAGE_SIGNATURES: Array<{ type: string; test: (bytes: Buffer) => boolean }> = [
  {
    type: 'png',
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { type: 'jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export const contentCommands: CommandSpec[] = [
  {
    name: 'announcement list',
    summary: '公告列表（含未发布）',
    write: false,
    async run(ctx) {
      const { client } = await ctx.auth();
      const rows = await withReadRetry(() => listAnnouncements(client));
      return {
        data: rows,
        human: table(
          rows.map((row) => ({ ...row, published: row.is_published ? '已发布' : '未发布' })),
          ['sort_order', 'published', 'category', 'title', 'updated_at', 'id']
        ),
      };
    },
  },
  {
    name: 'announcement create',
    summary: '新建公告（默认不发布，加 --publish 立即发布）',
    write: true,
    options: {
      ...contentOptions,
      publish: { type: 'boolean', description: '创建后立即发布给用户' },
    },
    async run(ctx, input) {
      const title = stringOption(input, 'title')?.trim();
      const text = body(ctx, input)?.trim();
      if (!title || !text) throw new CliError('usage', '需要 --title 和 --body（或 --body-file）');
      const value = {
        category: category(stringOption(input, 'category'), 'announcement'),
        title,
        body: text,
        sort_order: sortOrder(input, 0),
        is_published: input.options.publish === true,
      };
      await ctx.confirm({
        action: value.is_published ? '新建并立即发布公告（用户可见）' : '新建公告（不发布）',
        human: JSON.stringify(value, null, 2),
        preview: value,
      });
      const { client } = await ctx.auth();
      const created = await createAnnouncement({
        client,
        category: value.category,
        title: value.title,
        body: value.body,
        sortOrder: value.sort_order,
        isPublished: value.is_published,
      });
      return {
        data: created,
        human: `已创建公告 ${created.id}${created.is_published ? '（已发布）' : '（未发布）'}`,
      };
    },
  },
  {
    name: 'announcement update',
    summary: '修改公告内容（发布状态用 publish/unpublish）',
    write: true,
    positionals: [{ name: 'id', description: '公告 id', required: true }],
    options: contentOptions,
    async run(ctx, input) {
      const current = await findAnnouncement(ctx, requiredPositional(input, 'id'));
      const next = {
        category: category(stringOption(input, 'category'), current.category),
        title: stringOption(input, 'title')?.trim() ?? current.title,
        body: body(ctx, input)?.trim() ?? current.body,
        sort_order: sortOrder(input, current.sort_order),
      };
      const before = {
        category: current.category,
        title: current.title,
        body: current.body,
        sort_order: current.sort_order,
      };
      const diff = diffValues(before, next);
      if (diff.length === 0)
        return { data: { updated: false, reason: 'no_changes' }, human: '没有改动' };
      await ctx.confirm({
        action: `修改公告「${current.title}」${current.is_published ? '（已发布，用户立即可见）' : ''}`,
        human: formatDiff(diff),
        preview: diff,
      });
      const { client } = await ctx.auth();
      const updated = await updateAnnouncement({
        client,
        id: current.id,
        category: next.category,
        title: next.title,
        body: next.body,
        sortOrder: next.sort_order,
      });
      return {
        data: { updated: true, announcement: updated, diff },
        human: `已更新\n${formatDiff(diff)}`,
      };
    },
  },
  ...(['publish', 'unpublish'] as const).map(
    (verb): CommandSpec => ({
      name: `announcement ${verb}`,
      summary: verb === 'publish' ? '发布公告（用户可见）' : '下线公告',
      write: true,
      positionals: [{ name: 'id', description: '公告 id', required: true }],
      async run(ctx, input) {
        const current = await findAnnouncement(ctx, requiredPositional(input, 'id'));
        const publish = verb === 'publish';
        await ctx.confirm({
          action: `${publish ? '发布' : '下线'}公告「${current.title}」`,
          human: `当前：${current.is_published ? '已发布' : '未发布'}`,
          preview: { id: current.id, is_published: publish },
        });
        const { client } = await ctx.auth();
        const updated = await setAnnouncementPublished(client, current.id, publish);
        return { data: updated, human: publish ? '已发布' : '已下线' };
      },
    })
  ),
  {
    name: 'announcement delete',
    summary: '删除公告',
    write: true,
    positionals: [{ name: 'id', description: '公告 id', required: true }],
    async run(ctx, input) {
      const current = await findAnnouncement(ctx, requiredPositional(input, 'id'));
      await ctx.confirm({
        action: `删除公告「${current.title}」`,
        human: JSON.stringify(current, null, 2),
        preview: { id: current.id, title: current.title, is_published: current.is_published },
      });
      const { client } = await ctx.auth();
      await deleteAnnouncement(client, current.id);
      return { data: { deleted: true, id: current.id }, human: '已删除' };
    },
  },
  {
    name: 'invite records',
    summary: '邀请记录查询（只读）',
    write: false,
    options: {
      inviter: { type: 'string', description: '邀请人：用户 UUID 或 Telegram ID' },
      invitee: { type: 'string', description: '被邀请人：用户 UUID 或 Telegram ID' },
      from: { type: 'string', description: '绑定时间起（ISO，含）' },
      to: { type: 'string', description: '绑定时间止（ISO，不含）' },
      reward: { type: 'string', description: 'granted | none' },
      limit: {
        type: 'string',
        description: `条数，默认 ${INVITE_RECORDS_PAGE_SIZE}，最多 ${INVITE_RECORDS_MAX_PAGE_SIZE}`,
      },
      offset: { type: 'string', description: '偏移，默认 0' },
    },
    async run(ctx, input) {
      const reward = stringOption(input, 'reward');
      if (reward !== undefined && reward !== 'granted' && reward !== 'none') {
        throw new CliError('usage', '--reward 必须是 granted 或 none');
      }
      const offsetRaw = stringOption(input, 'offset');
      const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0)
        throw new CliError('usage', '--offset 必须是非负整数');
      const { client } = await ctx.auth();
      const page = await withReadRetry(() =>
        listInviteRecords({
          client,
          filters: {
            inviterRef: stringOption(input, 'inviter'),
            inviteeRef: stringOption(input, 'invitee'),
            boundFrom: stringOption(input, 'from'),
            boundTo: stringOption(input, 'to'),
            rewardStatus: reward ?? null,
          },
          limit: intOption(input, 'limit', INVITE_RECORDS_PAGE_SIZE, INVITE_RECORDS_MAX_PAGE_SIZE),
          offset,
        })
      );
      return {
        data: page,
        human: `共 ${page.total} 条\n${table(
          page.records.map((r) => ({
            ...r,
            inviter: r.inviter_display_name ?? r.inviter_tg_id,
            invitee: r.invitee_display_name ?? r.invitee_tg_id,
          })),
          ['bound_at', 'inviter', 'invitee', 'invite_code', 'reward_credits_total']
        )}`,
      };
    },
  },
  {
    name: 'invite poster',
    summary:
      '上传邀请海报图片，返回 URL（再写进 miniapp_invite_center_config 的 poster_url 才会使用）',
    write: true,
    positionals: [{ name: 'file', description: 'PNG / JPG / WEBP 文件', required: true }],
    async run(ctx, input) {
      const path = requiredPositional(input, 'file');
      const bytes = ctx.readBytes(path);
      const kind = IMAGE_SIGNATURES.find((signature) => signature.test(bytes));
      if (!kind) throw new CliError('validation_failed', `${path} 不是 PNG/JPG/WEBP 图片`);
      await ctx.confirm({
        action: '上传邀请海报到生产存储',
        human: `${path}（${kind.type}，${bytes.length} 字节）`,
        preview: { file: path, type: kind.type, bytes: bytes.length },
      });
      const { client, config } = await ctx.auth();
      const url = await uploadInvitePoster(client, config.apiUrl, bytes.toString('base64'));
      return {
        data: { poster_url: url },
        human: `已上传：${url}\n要生效，请把它写进 miniapp_invite_center_config 的 poster_url 并发布。`,
      };
    },
  },
];
