import {
  FREE_ZONE_CHECK_LABELS,
  FREE_ZONE_STATUS_LABELS,
  fetchFreeZoneStatus,
  screenFreeZoneCandidates,
} from '@miniapp/admin-client';
import {
  AdminFreeZoneScreeningRequestSchema,
  type AdminFreeZoneScreeningRequest,
  type AdminFreeZoneScreeningResponse,
  type AdminFreeZoneStatusResponse,
} from '@miniapp/shared';
import { withReadRetry } from '../client';
import { stringOption, type CommandSpec } from '../command';
import { CliError } from '../errors';

/** 畅聊调试：和运营平台畅聊页的「线上状态」「按当前门槛筛选」同一组只读接口。 */

function statusHuman(data: AdminFreeZoneStatusResponse): string {
  const lines = [
    `总开关：${data.enabled ? '开' : '关'}；最近评估：${data.last_evaluated_at ?? '还没评估过'}`,
  ];
  for (const model of data.models) {
    const status = model.status ? FREE_ZONE_STATUS_LABELS[model.status] : '未评估';
    const detail =
      model.status === 'listed'
        ? `供应商 ${model.providers.join('、')}`
        : model.status === 'cooling'
          ? `冷却到 ${model.cooldown_until ?? '?'}`
          : `连续达标 ${model.consecutive_passes}/${data.required_passes}`;
    const removed = model.in_config ? '' : '（已不在候选池）';
    lines.push(
      `${status}\t${model.display_name ?? model.candidate_id}${removed}\t${detail}${model.last_reason ? `\t${model.last_reason}` : ''}`
    );
  }
  return lines.join('\n');
}

function screeningHuman(data: AdminFreeZoneScreeningResponse): string {
  const passed = data.models.filter((model) => model.pass).length;
  const lines = [`${data.models.length} 个候选，${passed} 个达标（${data.checked_at}）`];
  for (const model of data.models) {
    const mark = model.error ? '?' : model.pass ? '✓' : '✗';
    const tail = model.error
      ? model.error
      : model.pass
        ? `会选 ${model.picked_provider ?? '?'}`
        : model.reasons.join('；');
    lines.push(`${mark} ${model.display_name}（${model.surplus_model}）\t${tail}`);
  }
  const helpful = data.impact.filter((item) => item.unlocks.length > 0);
  lines.push(
    helpful.length
      ? `只放开一项能多达标：${helpful.map((item) => `${FREE_ZONE_CHECK_LABELS[item.key]} +${item.unlocks.length}`).join('，')}`
      : '单独放开任何一项都不会多出达标模型'
  );
  return lines.join('\n');
}

export const freeZoneCommands: CommandSpec[] = [
  {
    name: 'free-zone status',
    summary: '畅聊：每个候选的线上状态（在架/未上架/冷却中、供应商、最近原因）和最近上下架记录',
    write: false,
    async run(ctx) {
      const { client, config } = await ctx.auth();
      const data = await withReadRetry(() => fetchFreeZoneStatus(client, config.apiUrl));
      return { data, human: statusHuman(data) };
    },
  },
  {
    name: 'free-zone screen',
    summary: '畅聊：拿 Surplus 实时行情按初筛门槛过一遍候选池（只读；不带 --file 时用已发布配置）',
    write: false,
    options: {
      file: {
        type: 'string',
        description: 'free_zone_config 的 JSON（或只含 candidates、screening），用来试未发布的门槛',
      },
    },
    examples: [
      'pnpm admin free-zone screen --json',
      'pnpm admin free-zone screen --file draft.json',
    ],
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      let request: AdminFreeZoneScreeningRequest | undefined;
      if (file) {
        const raw = ctx.readJsonFile(file) as Record<string, unknown> | null;
        const parsed = AdminFreeZoneScreeningRequestSchema.safeParse({
          candidates: raw?.candidates,
          screening: raw?.screening ?? {},
        });
        if (!parsed.success) {
          throw new CliError('validation_failed', '文件未通过校验', {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }
        request = parsed.data;
      }
      const { client, config } = await ctx.auth();
      const data = await screenFreeZoneCandidates(client, config.apiUrl, request);
      return { data, human: screeningHuman(data) };
    },
  },
];
