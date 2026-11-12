import {
  FREE_ZONE_CHECK_LABELS,
  FREE_ZONE_STATUS_GROUPS,
  FREE_ZONE_STATUS_LABELS,
  fetchFreeZoneStatus,
  freeZoneBusinessText,
  freeZoneProbeText,
  freeZoneReasonView,
  freeZoneStatusGroup,
  listFreeZoneModelNow,
  screenFreeZoneCandidates,
} from '@miniapp/admin-client';
import {
  AdminFreeZoneScreeningRequestSchema,
  type AdminFreeZoneScreeningRequest,
  type AdminFreeZoneScreeningResponse,
  type AdminFreeZoneStatusModel,
  type AdminFreeZoneStatusResponse,
} from '@miniapp/shared';
import { withReadRetry } from '../client';
import { requiredPositional, stringOption, type CommandSpec } from '../command';
import { CliError } from '../errors';

/** 畅聊调试：和运营平台畅聊页的「线上状态」「按当前门槛筛选」「立即上架」同一组接口。 */

function statusLine(model: AdminFreeZoneStatusModel, requiredPasses: number): string {
  const status = model.status ? FREE_ZONE_STATUS_LABELS[model.status] : '未评估';
  const detail =
    model.status === 'listed'
      ? [
          `供应商 ${model.providers.join('、')}${freeZoneProbeText(model) ? `（${freeZoneProbeText(model)}）` : ''}`,
          freeZoneBusinessText(model),
        ]
          .filter(Boolean)
          .join('\t')
      : model.status === 'cooling'
        ? `冷却到 ${model.cooldown_until ?? '?'}`
        : `连续达标 ${model.consecutive_passes}/${requiredPasses}`;
  const marks = [
    model.in_config ? '' : '（已不在候选池）',
    model.ever_listed && model.last_delist?.cause === 'official' ? '（曾上架）' : '',
  ].join('');
  const view = freeZoneReasonView(model);
  const reason =
    view.kind === 'text'
      ? view.text
      : view.kind === 'tags'
        ? [view.tags.map((tag) => `${tag.failed ? '✗' : '✓'}${tag.text}`).join(' '), view.note]
            .filter(Boolean)
            .join('；')
        : '';
  const delist =
    model.last_delist?.cause === 'business' && model.status !== 'listed'
      ? `\t下架：${model.last_delist.reason ?? ''}`
      : '';
  return `  ${status}\t${model.display_name ?? model.candidate_id}${marks}\t${detail}${delist}${reason ? `\t${reason}` : ''}`;
}

function statusHuman(data: AdminFreeZoneStatusResponse): string {
  const lines = [
    `总开关：${data.enabled ? '开' : '关'}；最近评估：${data.last_evaluated_at ?? '还没评估过'}`,
  ];
  for (const group of FREE_ZONE_STATUS_GROUPS) {
    const models = data.models.filter((model) => freeZoneStatusGroup(model) === group.key);
    lines.push(`【${group.label}】${models.length} 个`);
    for (const model of models) lines.push(statusLine(model, data.required_passes));
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

/** 按 id（可省略 free- 前缀）或显示名找候选。 */
function findModel(
  data: AdminFreeZoneStatusResponse,
  query: string
): AdminFreeZoneStatusModel | undefined {
  const lower = query.trim().toLowerCase();
  return data.models.find(
    (model) =>
      model.in_config &&
      (model.candidate_id === lower ||
        model.candidate_id === `free-${lower}` ||
        model.display_name?.toLowerCase() === lower)
  );
}

function listNowPlan(model: AdminFreeZoneStatusModel, provider: string | undefined): string {
  const status = model.status ? FREE_ZONE_STATUS_LABELS[model.status] : '未评估';
  const excluded = Object.entries(model.excluded_providers)
    .map(([name, until]) => `${name}（到 ${until}）`)
    .join('、');
  return [
    `候选：${model.display_name ?? model.candidate_id}（${model.candidate_id}）`,
    `现在：${status}${model.status === 'cooling' ? `，冷却到 ${model.cooldown_until ?? '?'}` : ''}`,
    model.last_delist ? `上次下架：${model.last_delist.at} ${model.last_delist.reason ?? ''}` : '',
    excluded ? `排除中的供应商：${excluded}` : '',
    `供应商：${provider ? `${provider}（指定）` : '按当前行情和初筛门槛选'}；上架前先真发一次派单探测，按折扣底线派不出单就不上`,
    '上架后跳过连续达标和冷却，立即对用户可见；之后照常每 30 分钟评估，不达标照样换供应商或下架。',
  ]
    .filter(Boolean)
    .join('\n');
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
  {
    name: 'free-zone list-now',
    summary: '畅聊：立即上架一个候选（跳过连续达标和冷却；之后照常评估）',
    write: true,
    positionals: [
      { name: 'candidate', description: '候选 id（可省略 free- 前缀）或显示名', required: true },
    ],
    options: {
      provider: { type: 'string', description: '指定供应商；不填按当前行情和初筛门槛选' },
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
        action: `立即上架畅聊模型 ${model.display_name ?? model.candidate_id}`,
        human: listNowPlan(model, provider),
        preview: {
          candidate_id: model.candidate_id,
          status: model.status,
          cooldown_until: model.cooldown_until,
          excluded_providers: model.excluded_providers,
          provider: provider ?? null,
        },
      });
      const data = await listFreeZoneModelNow(client, config.apiUrl, {
        candidate_id: model.candidate_id,
        provider,
      });
      return {
        data,
        human: `已上架 ${data.display_name}，供应商 ${data.provider}（${data.provider_source === 'requested' ? '指定' : '按行情选'}）`,
      };
    },
  },
];
