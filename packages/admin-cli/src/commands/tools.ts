import { randomUUID } from 'node:crypto';
import {
  createTextPostprocessApi,
  readAdminAccessToken,
  testCreatorCharacterReview,
  testImageTextModelConfig,
  type TextPostprocessApi,
} from '@miniapp/admin-client';
import {
  AdminImageTextModelTestRequestSchema,
  CreatorReviewTestRequestSchema,
  type TextPostprocessAdminState,
} from '@miniapp/shared';
import { withReadRetry } from '../client';
import { requiredPositional, stringOption, type CommandSpec, type Ctx } from '../command';
import { diffValues, formatDiff } from '../diff';
import { CliError, classifyError } from '../errors';

/**
 * 回复富文本规则走后端 `/api/admin/text-postprocess*`：写入带 request_id 与 CAS 前提。
 * CLI 自动从当前状态填这些前提；写入超时/结果未知时不重试，提示用 recover 按 request_id 查结果。
 */

async function textApi(ctx: Ctx): Promise<TextPostprocessApi> {
  const { client, config } = await ctx.auth();
  return createTextPostprocessApi({
    baseUrl: config.apiUrl,
    getAccessToken: () => readAdminAccessToken(client),
  });
}

async function readState(api: TextPostprocessApi): Promise<TextPostprocessAdminState> {
  return withReadRetry(() => api.readState());
}

/** 写请求失败时把 request_id 附上，结果未知时可用 recover 查询。 */
async function mutate<T>(requestId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const classified = classifyError(error);
    const details =
      typeof classified.details === 'object' && classified.details !== null
        ? classified.details
        : {};
    throw new CliError(
      classified.code,
      classified.code === 'unavailable'
        ? `${classified.message}。结果未知，请先执行 pnpm admin text-rules recover ${requestId} 查询，不要直接重试`
        : classified.message,
      { ...details, request_id: requestId }
    );
  }
}

function requireDraft(state: TextPostprocessAdminState) {
  if (!state.draft) throw new CliError('not_found', '回复富文本规则没有草稿');
  return state.draft;
}

export const toolCommands: CommandSpec[] = [
  {
    name: 'text-rules get',
    summary: '回复富文本规则：线上版本、草稿与最近历史',
    write: false,
    options: { 'before-version': { type: 'string', description: '翻页：只看早于该版本的历史' } },
    async run(ctx, input) {
      const api = await textApi(ctx);
      const raw = stringOption(input, 'before-version');
      const before = raw === undefined ? undefined : Number(raw);
      if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
        throw new CliError('usage', '--before-version 必须是正整数');
      }
      const state = await withReadRetry(() =>
        api.readState(before === undefined ? {} : { beforeVersion: before })
      );
      return {
        data: state,
        human: [
          `线上版本：${state.runtime_version ?? '未发布'}`,
          `草稿：${state.draft ? `有（修订 ${state.draft.draft_revision}，${state.draft.updated_at}）` : '无'}`,
          `历史：${state.history.map((item) => `v${item.version}`).join(' ') || '无'}${state.has_more ? ' …' : ''}`,
        ].join('\n'),
      };
    },
  },
  {
    name: 'text-rules draft',
    summary:
      '保存规则草稿（文件内容即草稿 source，结构同 text-rules get 返回的 draft.source / published.source）',
    write: true,
    options: { file: { type: 'string', description: 'source JSON 文件' } },
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      if (!file) throw new CliError('usage', '需要 --file');
      const source = ctx.readJsonFile(file);
      const api = await textApi(ctx);
      const state = await readState(api);
      const diff = diffValues(state.draft?.source ?? state.published?.source ?? null, source);
      const requestId = randomUUID();
      await ctx.confirm({
        action: '保存回复富文本规则草稿（不生效）',
        human: formatDiff(diff),
        preview: diff,
      });
      const outcome = await mutate(requestId, () =>
        api.save({
          request_id: requestId,
          expected_runtime_version: state.runtime_version,
          expected_draft_updated_at: state.draft?.updated_at ?? null,
          expected_draft_digest: state.draft?.content_digest ?? null,
          source: source as never,
        })
      );
      return {
        data: { request_id: requestId, outcome, diff },
        human: '草稿已保存。下一步：pnpm admin text-rules publish',
      };
    },
  },
  {
    name: 'text-rules publish',
    summary: '发布规则草稿，立即在生产生效',
    write: true,
    async run(ctx) {
      const api = await textApi(ctx);
      const state = await readState(api);
      const draft = requireDraft(state);
      const diff = diffValues(state.published?.source ?? null, draft.source);
      const requestId = randomUUID();
      await ctx.confirm({
        action: '发布回复富文本规则，立即在生产生效',
        human: formatDiff(diff),
        preview: diff,
      });
      const outcome = await mutate(requestId, () =>
        api.publish({
          request_id: requestId,
          expected_runtime_version: state.runtime_version,
          expected_draft_updated_at: draft.updated_at,
          expected_draft_digest: draft.content_digest,
          draft_revision: draft.draft_revision,
        })
      );
      return {
        data: { request_id: requestId, outcome, diff },
        human: `已发布，版本 ${outcome.version ?? outcome.runtime_version ?? ''}`,
      };
    },
  },
  {
    name: 'text-rules rollback',
    summary: '恢复到某个历史版本（生成新版本）',
    write: true,
    positionals: [{ name: 'version', description: '目标版本号', required: true }],
    async run(ctx, input) {
      const target = Number(requiredPositional(input, 'version'));
      if (!Number.isInteger(target) || target < 1)
        throw new CliError('usage', '<version> 必须是正整数');
      const api = await textApi(ctx);
      const state = await readState(api);
      if (state.runtime_version === null) throw new CliError('not_found', '尚无已发布版本');
      const historical = state.history.find((item) => item.version === target);
      const diff = historical ? diffValues(state.published?.source ?? null, historical.source) : [];
      const requestId = randomUUID();
      await ctx.confirm({
        action: `回滚回复富文本规则到 v${target}，立即在生产生效`,
        human: historical ? formatDiff(diff) : '（目标版本不在最近历史里，无法预览差异）',
        preview: diff,
      });
      const outcome = await mutate(requestId, () =>
        api.rollback({
          request_id: requestId,
          expected_runtime_version: state.runtime_version as number,
          target_version: target,
        })
      );
      return { data: { request_id: requestId, outcome }, human: '已回滚' };
    },
  },
  {
    name: 'text-rules discard',
    summary: '放弃规则草稿',
    write: true,
    async run(ctx) {
      const api = await textApi(ctx);
      const state = await readState(api);
      const draft = requireDraft(state);
      const requestId = randomUUID();
      await ctx.confirm({
        action: '放弃回复富文本规则草稿',
        human: formatDiff(diffValues(state.published?.source ?? null, draft.source)),
        preview: { draft_revision: draft.draft_revision },
      });
      const outcome = await mutate(requestId, () =>
        api.discard({
          request_id: requestId,
          expected_draft_updated_at: draft.updated_at,
          expected_draft_digest: draft.content_digest,
        })
      );
      return { data: { request_id: requestId, outcome }, human: '草稿已放弃' };
    },
  },
  {
    name: 'text-rules recover',
    summary: '按 request_id 查询一次写入的最终结果（写入超时后用）',
    write: false,
    positionals: [{ name: 'request-id', description: '写入时返回的 request_id', required: true }],
    async run(ctx, input) {
      const api = await textApi(ctx);
      const result = await withReadRetry(() => api.lookup(requiredPositional(input, 'request-id')));
      return { data: result };
    },
  },
  {
    name: 'test image-text-model',
    summary: '用一份配置试调图片描述模型（不发布、不改配置，但会产生一次模型调用）',
    write: false,
    options: { file: { type: 'string', description: '请求 JSON（同网页“测试”按钮提交的内容）' } },
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      if (!file) throw new CliError('usage', '需要 --file');
      const parsed = AdminImageTextModelTestRequestSchema.safeParse(ctx.readJsonFile(file));
      if (!parsed.success) {
        throw new CliError('validation_failed', '请求未通过校验', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const { client, config } = await ctx.auth();
      return { data: await testImageTextModelConfig(client, config.apiUrl, parsed.data) };
    },
  },
  {
    name: 'test creator-review',
    summary: '用一份审核提示词试审角色资料（不发布、不改角色，但会产生一次模型调用）',
    write: false,
    options: { file: { type: 'string', description: '请求 JSON：{ prompt, material }' } },
    async run(ctx, input) {
      const file = stringOption(input, 'file');
      if (!file) throw new CliError('usage', '需要 --file');
      const parsed = CreatorReviewTestRequestSchema.safeParse(ctx.readJsonFile(file));
      if (!parsed.success) {
        throw new CliError('validation_failed', '请求未通过校验', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      const { client, config } = await ctx.auth();
      return { data: await testCreatorCharacterReview(client, config.apiUrl, parsed.data) };
    },
  },
];
