import {
  FREE_ZONE_STATUS_GROUPS,
  FREE_ZONE_STATUS_LABELS,
  delistFreeZoneModelNow,
  fetchFreeZoneStatus,
  freeZoneDelistText,
  listFreeZoneModelNow,
  pinFreeZoneModel,
} from '@miniapp/admin-client';
import type { AdminFreeZoneStatusModel, AdminFreeZoneStatusResponse } from '@miniapp/shared';
import { withReadRetry } from '../client';
import { requiredPositional, stringOption, type CommandSpec } from '../command';
import { CliError } from '../errors';

/** 畅聊：和运营平台畅聊页的「线上状态」「上架」「下架」「保上」同一组接口。 */

function statusLine(model: AdminFreeZoneStatusModel): string {
  const name = `${model.display_name ?? model.candidate_id}${model.in_config ? '' : '（已不在候选池）'}`;
  const detail =
    model.status === 'listed'
      ? `供应商 ${model.providers.join('、')}`
      : model.last_delist
        ? `${model.last_delist.at} 下架：${freeZoneDelistText(model)}`
        : '没上过架';
  return `  ${FREE_ZONE_STATUS_LABELS[model.status]}${model.pinned ? '·保上' : ''}\t${name}\t${detail}`;
}

function statusHuman(data: AdminFreeZoneStatusResponse): string {
  const lines = [`总开关：${data.enabled ? '开' : '关'}`];
  for (const group of FREE_ZONE_STATUS_GROUPS) {
    const models = data.models.filter((model) => model.status === group.key);
    lines.push(`【${group.label}】${models.length} 个`);
    for (const model of models) lines.push(statusLine(model));
  }
  return lines.join('\n');
}

/** 按 id（可省略 free- 前缀）或显示名找候选；下架时连已不在候选池的行也找。 */
function findModel(
  data: AdminFreeZoneStatusResponse,
  query: string,
  includeOutOfPool = false
): AdminFreeZoneStatusModel | undefined {
  const lower = query.trim().toLowerCase();
  return data.models.find(
    (model) =>
      (model.in_config || includeOutOfPool) &&
      (model.candidate_id === lower ||
        model.candidate_id === `free-${lower}` ||
        model.display_name?.toLowerCase() === lower)
  );
}

function listNowPlan(model: AdminFreeZoneStatusModel, provider: string | undefined): string {
  return [
    `候选：${model.display_name ?? model.candidate_id}（${model.candidate_id}）`,
    model.last_delist
      ? `上次下架：${model.last_delist.at} ${freeZoneDelistText(model)}`
      : '没下架过',
    `供应商：${provider ? `${provider}（指定）` : '按当前报价选达到折扣底线、折扣最高的一家'}`,
    '上架后立即对用户可见；供应商固定，之后不自动变；连续被拒单会自动下架（保上的除外）。',
  ].join('\n');
}

export const freeZoneCommands: CommandSpec[] = [
  {
    name: 'free-zone status',
    summary: '畅聊：每个候选的线上状态（在架/未上架、供应商、上次下架原因）和最近上下架记录',
    write: false,
    async run(ctx) {
      const { client, config } = await ctx.auth();
      const data = await withReadRetry(() => fetchFreeZoneStatus(client, config.apiUrl));
      return { data, human: statusHuman(data) };
    },
  },
  {
    name: 'free-zone list-now',
    summary: '畅聊：上架一个候选（固定一家供应商，之后不自动变）',
    write: true,
    positionals: [
      { name: 'candidate', description: '候选 id（可省略 free- 前缀）或显示名', required: true },
    ],
    options: {
      provider: {
        type: 'string',
        description: '指定供应商；不填按当前报价选达到折扣底线、折扣最高的一家',
      },
    },
    examples: [
      'pnpm admin free-zone list-now glm-5',
      'pnpm admin free-zone list-now "GLM 5" --provider zai --yes',
    ],
    async run(ctx, input) {
      const query = requiredPositional(input, 'candidate');
      const provider = stringOption(input, 'provider');
      const { client, config } = await ctx.auth();
      const status = await withReadRetry(() => fetchFreeZoneStatus(client, config.apiUrl));
      const model = findModel(status, query);
      if (!model) throw new CliError('not_found', `已发布的候选池里找不到「${query}」`);
      if (model.status === 'listed') {
        throw new CliError('conflict', `${model.display_name ?? model.candidate_id} 已经在架`);
      }
      await ctx.confirm({
        action: `上架畅聊模型 ${model.display_name ?? model.candidate_id}`,
        human: listNowPlan(model, provider),
        preview: {
          candidate_id: model.candidate_id,
          status: model.status,
          provider: provider ?? null,
        },
      });
      const data = await listFreeZoneModelNow(client, config.apiUrl, {
        candidate_id: model.candidate_id,
        provider,
      });
      return {
        data,
        human: `已上架 ${data.display_name}，供应商 ${data.provider}（${data.provider_source === 'requested' ? '指定' : '按报价选'}）`,
      };
    },
  },
  {
    name: 'free-zone delist-now',
    summary: '畅聊：手动下架一个在架模型（不会自动回来，要用时 list-now）',
    write: true,
    positionals: [
      { name: 'candidate', description: '候选 id（可省略 free- 前缀）或显示名', required: true },
    ],
    examples: [
      'pnpm admin free-zone delist-now glm-5',
      'pnpm admin free-zone delist-now "GLM 5" --yes',
    ],
    async run(ctx, input) {
      const query = requiredPositional(input, 'candidate');
      const { client, config } = await ctx.auth();
      const status = await withReadRetry(() => fetchFreeZoneStatus(client, config.apiUrl));
      const model = findModel(status, query, true);
      if (!model) throw new CliError('not_found', `找不到「${query}」`);
      const name = model.display_name ?? model.candidate_id;
      if (model.status !== 'listed') throw new CliError('conflict', `${name} 现在不在架`);
      await ctx.confirm({
        action: `手动下架畅聊模型 ${name}`,
        human: [
          `候选：${name}（${model.candidate_id}）${model.in_config ? '' : '，已不在候选池'}`,
          `现在：在架，供应商 ${model.providers.join('、')}`,
          `下架后用户马上看不到，正在用它的用户下一轮自动换成别的免费模型；不会自动回来，要用时 list-now。${model.pinned ? '同时取消保上。' : ''}`,
        ].join('\n'),
        preview: {
          candidate_id: model.candidate_id,
          status: model.status,
          providers: model.providers,
        },
      });
      const data = await delistFreeZoneModelNow(client, config.apiUrl, {
        candidate_id: model.candidate_id,
      });
      return {
        data,
        human: `已下架 ${data.display_name}（原供应商 ${data.providers.join('、')}）`,
      };
    },
  },
  {
    name: 'free-zone pin',
    summary: '畅聊：保上 / 取消保上（保上的模型不再被自动下架；没在架会顺手上架）',
    write: true,
    positionals: [
      { name: 'candidate', description: '候选 id（可省略 free- 前缀）或显示名', required: true },
    ],
    options: {
      off: { type: 'boolean', description: '取消保上（在架状态不变）' },
    },
    examples: [
      'pnpm admin free-zone pin deepseek-v4-1-flash-1017',
      'pnpm admin free-zone pin "Gemini 3 Flash Preview" --off --yes',
    ],
    async run(ctx, input) {
      const query = requiredPositional(input, 'candidate');
      const pinned = input.options.off !== true;
      const { client, config } = await ctx.auth();
      const status = await withReadRetry(() => fetchFreeZoneStatus(client, config.apiUrl));
      const model = findModel(status, query);
      if (!model) throw new CliError('not_found', `已发布的候选池里找不到「${query}」`);
      const name = model.display_name ?? model.candidate_id;
      await ctx.confirm({
        action: `${pinned ? '保上' : '取消保上'}畅聊模型 ${name}`,
        human: [
          `候选：${name}（${model.candidate_id}），现在：${FREE_ZONE_STATUS_LABELS[model.status]}${model.pinned ? '，已保上' : ''}`,
          pinned
            ? '保上后在架期间不再自动下架（连续被拒单只记日志，这些轮次都由兜底交付）；没在架会马上上架。要下架只能手动下架（同时取消保上）。'
            : '取消后恢复连续拒单自动下架；在架状态不变。',
        ].join('\n'),
        preview: { candidate_id: model.candidate_id, pinned, was_pinned: model.pinned },
      });
      const data = await pinFreeZoneModel(client, config.apiUrl, {
        candidate_id: model.candidate_id,
        pinned,
      });
      return {
        data,
        human: `${data.display_name}：${data.pinned ? '已保上' : '已取消保上'}，${data.listed ? '在架' : '未在架'}${data.note ? `。${data.note}` : ''}`,
      };
    },
  },
];
