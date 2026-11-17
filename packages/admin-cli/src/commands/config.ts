import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodIssue } from 'zod';
import {
  configMetadata,
  configSchemas,
  discardDraft,
  findConfigMenuLocation,
  getDrafts,
  getManagedConfigs,
  getReleases,
  isTextManagedConfig,
  managedConfigKeys,
  publishDraft,
  rollbackRelease,
  saveDraft,
  type ConfigDraft,
  type ConfigRelease,
  type ManagedConfig,
  type ManagedConfigKey,
} from '@miniapp/admin-client';
import { CLI_ENVIRONMENT, withReadRetry } from '../client';
import {
  intOption,
  parseJson,
  requiredPositional,
  stringOption,
  type CommandInput,
  type CommandSpec,
  type Ctx,
} from '../command';
import { deepEqual, diffValues, formatDiff } from '../diff';
import { CliError } from '../errors';
import { table } from '../output';

/** 配置在页面/数据库里的“值”：文本类 key 用 text_value，其余用 value。 */
type ConfigValue = unknown;

function requireKey(raw: string): ManagedConfigKey {
  if ((managedConfigKeys as readonly string[]).includes(raw)) return raw as ManagedConfigKey;
  throw new CliError('not_found', `未知配置 ${raw}。用 pnpm admin config list 查看全部 key`);
}

function label(key: ManagedConfigKey): string {
  return configMetadata[key].label;
}

function valueKind(key: ManagedConfigKey): 'text' | 'json' {
  return isTextManagedConfig(key) ? 'text' : 'json';
}

function publishedValue(key: ManagedConfigKey, config: ManagedConfig | undefined): ConfigValue {
  if (!config) return null;
  return isTextManagedConfig(key) ? config.text_value : config.value;
}

function draftValue(key: ManagedConfigKey, draft: ConfigDraft): ConfigValue {
  return isTextManagedConfig(key) ? draft.text_value : draft.value;
}

function releaseValue(key: ManagedConfigKey, release: ConfigRelease): ConfigValue {
  return isTextManagedConfig(key) ? (release.text_value ?? null) : release.value;
}

interface ConfigState {
  config: ManagedConfig | undefined;
  draft: ConfigDraft | undefined;
}

async function loadState(client: SupabaseClient, key: ManagedConfigKey): Promise<ConfigState> {
  const [configs, drafts] = await withReadRetry(() =>
    Promise.all([getManagedConfigs(client), getDrafts(client, CLI_ENVIRONMENT)])
  );
  return {
    config: configs.find((row) => row.key === key),
    draft: drafts.find((row) => row.config_key === key && row.status === 'draft'),
  };
}

function formatIssues(issues: ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.length ? issue.path.join('.') : '(值)',
    message: issue.message,
  }));
}

/** 与网页保存草稿相同的校验：注册表里的 zod schema；文本类 key 先确认是字符串。 */
function validateValue(key: ManagedConfigKey, candidate: unknown): ConfigValue {
  if (isTextManagedConfig(key) && typeof candidate !== 'string') {
    throw new CliError('validation_failed', `${key} 是文本配置，值必须是字符串`);
  }
  const parsed = configSchemas[key].safeParse(candidate);
  if (!parsed.success) {
    throw new CliError('validation_failed', `${label(key)}（${key}）未通过校验，没有提交`, {
      issues: formatIssues(parsed.error.issues),
    });
  }
  return parsed.data;
}

/** --file 读文件、--value 读命令行；文本类 key 原样当字符串，其余按 JSON 解析。 */
function readCandidate(ctx: Ctx, key: ManagedConfigKey, input: CommandInput): unknown {
  const file = stringOption(input, 'file');
  const value = stringOption(input, 'value');
  if ((file === undefined) === (value === undefined)) {
    throw new CliError('usage', '需要且只能提供 --file 或 --value 之一');
  }
  if (isTextManagedConfig(key)) return file !== undefined ? ctx.readText(file) : value;
  return file !== undefined ? ctx.readJsonFile(file) : parseJson(value ?? '', '--value');
}

const valueOptions = {
  file: { type: 'string', description: '新值文件：JSON；文本类配置为纯文本' },
  value: { type: 'string', description: '新值：JSON 字符串；文本类配置为纯文本' },
} as const;

const keyArg = [{ name: 'key', description: '配置 key（见 config list）', required: true }];

function summarizeDraft(key: ManagedConfigKey, state: ConfigState) {
  if (!state.draft) return null;
  const value = draftValue(key, state.draft);
  return {
    id: state.draft.id,
    base_version: state.draft.base_version,
    updated_at: state.draft.updated_at,
    stale: state.draft.base_version !== (state.config?.version ?? 0),
    differs_from_published: !deepEqual(value, publishedValue(key, state.config)),
  };
}

export const configCommands: CommandSpec[] = [
  {
    name: 'config list',
    summary: '列出全部运营配置：key、中文名、菜单位置、线上版本、是否有草稿',
    write: false,
    options: { group: { type: 'string', description: '只看某个菜单组（id 或中文名）' } },
    async run(ctx, input) {
      const { client } = await ctx.auth();
      const [configs, drafts] = await withReadRetry(() =>
        Promise.all([getManagedConfigs(client), getDrafts(client, CLI_ENVIRONMENT)])
      );
      const group = stringOption(input, 'group');
      const rows = managedConfigKeys
        .map((key) => {
          const location = findConfigMenuLocation(key, label);
          const config = configs.find((row) => row.key === key);
          return {
            key,
            label: label(key),
            group: location?.groupLabel ?? null,
            group_id: location?.groupId ?? null,
            entry: location?.entryLabel ?? null,
            value_kind: valueKind(key),
            version: config?.version ?? null,
            updated_at: config?.updated_at ?? null,
            has_draft: drafts.some((row) => row.config_key === key && row.status === 'draft'),
          };
        })
        .filter((row) => !group || row.group === group || row.group_id === group);
      return {
        data: rows,
        human: table(rows, ['group', 'entry', 'label', 'key', 'version', 'has_draft']),
      };
    },
  },
  {
    name: 'config describe',
    summary: '查看配置说明、默认值、值类型、线上值与草稿状态（改之前先看这个）',
    write: false,
    positionals: keyArg,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      const location = findConfigMenuLocation(key, label);
      const data = {
        key,
        label: label(key),
        description: configMetadata[key].description,
        menu: location,
        value_kind: valueKind(key),
        default_value: configMetadata[key].defaultValue,
        version: state.config?.version ?? null,
        updated_at: state.config?.updated_at ?? null,
        value: publishedValue(key, state.config),
        draft: summarizeDraft(key, state),
      };
      return {
        data,
        human: [
          `${data.label}（${key}）`,
          data.description,
          `菜单：${location ? `${location.groupLabel} / ${location.entryLabel}` : '（无入口）'}`,
          `类型：${data.value_kind === 'text' ? '文本' : 'JSON'}　线上版本：${data.version ?? '未发布'}`,
          `草稿：${data.draft ? `有（${data.draft.updated_at}${data.draft.stale ? '，已过期' : ''}）` : '无'}`,
          '线上值：',
          typeof data.value === 'string' ? data.value : JSON.stringify(data.value, null, 2),
        ].join('\n'),
      };
    },
  },
  {
    name: 'config get',
    summary: '读取配置的线上值',
    write: false,
    positionals: keyArg,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      const value = publishedValue(key, state.config);
      return {
        data: {
          key,
          label: label(key),
          value_kind: valueKind(key),
          version: state.config?.version ?? null,
          updated_at: state.config?.updated_at ?? null,
          value,
        },
        human: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      };
    },
  },
  {
    name: 'config validate',
    summary: '只做本地校验，不提交（规则与网页保存草稿相同）',
    write: false,
    positionals: keyArg,
    options: valueOptions,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const value = validateValue(key, readCandidate(ctx, key, input));
      return { data: { key, valid: true, normalized_value: value }, human: '校验通过' };
    },
  },
  {
    name: 'config draft get',
    summary: '读取配置当前草稿（每个配置只有一份草稿，网页和 CLI 共用）',
    write: false,
    positionals: keyArg,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      if (!state.draft) return { data: { key, draft: null }, human: '没有草稿' };
      const value = draftValue(key, state.draft);
      return {
        data: { key, draft: { ...summarizeDraft(key, state), value } },
        human: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      };
    },
  },
  {
    name: 'config draft set',
    summary: '校验后保存草稿（不生效，发布才生效）；返回与线上值的差异',
    write: true,
    positionals: keyArg,
    options: {
      ...valueOptions,
      description: { type: 'string', description: '草稿说明（默认用配置说明）' },
      'replace-draft': {
        type: 'boolean',
        description: '已有与线上不同的草稿（可能是别人在网页上未发布的改动）时仍覆盖',
      },
    },
    examples: [
      'pnpm admin config get miniapp_payment_plans --json > plans.json  # 改 plans.json 里的 value',
      'pnpm admin config draft set miniapp_payment_plans --file plans.json --json',
    ],
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const next = validateValue(key, readCandidate(ctx, key, input));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      const current = publishedValue(key, state.config);

      if (state.draft && !input.options['replace-draft']) {
        const existing = draftValue(key, state.draft);
        if (!deepEqual(existing, current) && !deepEqual(existing, next)) {
          throw new CliError(
            'draft_exists',
            `${label(key)} 已有一份与线上不同的草稿（${state.draft.updated_at}），可能是别人未发布的改动。确认可覆盖后加 --replace-draft`,
            { draft_vs_published: diffValues(current, existing) }
          );
        }
      }

      const diff = diffValues(current, next);
      if (diff.length === 0 && !state.draft) {
        return {
          data: { key, saved: false, reason: 'no_changes', diff },
          human: '与线上值相同，未保存草稿',
        };
      }
      await ctx.confirm({
        action: `保存草稿 ${label(key)}（${key}）`,
        human: formatDiff(diff),
        preview: diff,
      });
      const saved = await saveDraft({
        client,
        environment: CLI_ENVIRONMENT,
        key,
        description: stringOption(input, 'description') ?? configMetadata[key].description,
        ...(isTextManagedConfig(key)
          ? { value: null, textValue: next as string }
          : { value: next }),
      });
      return {
        data: { key, saved: true, draft_id: saved.id, base_version: saved.base_version, diff },
        human: `草稿已保存（尚未生效）\n${formatDiff(diff)}\n下一步：pnpm admin config publish ${key}`,
      };
    },
  },
  {
    name: 'config diff',
    summary: '比较草稿与线上值',
    write: false,
    positionals: keyArg,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      if (!state.draft) return { data: { key, has_draft: false, diff: [] }, human: '没有草稿' };
      const diff = diffValues(publishedValue(key, state.config), draftValue(key, state.draft));
      return {
        data: { key, has_draft: true, draft: summarizeDraft(key, state), diff },
        human: formatDiff(diff),
      };
    },
  },
  {
    name: 'config publish',
    summary: '发布当前草稿，立即在生产生效',
    write: true,
    positionals: keyArg,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      if (!state.draft) {
        throw new CliError('not_found', `${label(key)} 没有草稿。先用 config draft set 保存草稿`);
      }
      const diff = diffValues(publishedValue(key, state.config), draftValue(key, state.draft));
      await ctx.confirm({
        action: `发布 ${label(key)}（${key}），立即在生产生效`,
        human: formatDiff(diff),
        preview: diff,
      });
      // 数据库按草稿的 base_version 做 CAS：期间若有人发布过新版本会拒绝，这里不重试。
      const release = await publishDraft(client, state.draft.id);
      return {
        data: { key, release_id: release.id, runtime_version: release.runtime_version, diff },
        human: `已发布，线上版本 ${release.runtime_version}\n${formatDiff(diff)}`,
      };
    },
  },
  {
    name: 'config discard',
    summary: '放弃当前草稿',
    write: true,
    positionals: keyArg,
    async run(ctx, input) {
      const key = requireKey(requiredPositional(input, 'key'));
      const { client } = await ctx.auth();
      const state = await loadState(client, key);
      if (!state.draft) return { data: { key, discarded: false }, human: '没有草稿' };
      const diff = diffValues(publishedValue(key, state.config), draftValue(key, state.draft));
      await ctx.confirm({
        action: `放弃 ${label(key)}（${key}）的草稿`,
        human: `将丢弃以下未发布改动：\n${formatDiff(diff)}`,
        preview: diff,
      });
      await discardDraft(client, state.draft.id);
      return { data: { key, discarded: true }, human: '草稿已放弃' };
    },
  },
  {
    name: 'config releases',
    summary: '发布历史（最近 100 条内）',
    write: false,
    positionals: [{ name: 'key', description: '只看某个配置', required: false }],
    options: {
      limit: { type: 'string', description: '条数，默认 20，最多 100' },
      'with-values': { type: 'boolean', description: '同时输出每次发布的值' },
    },
    async run(ctx, input) {
      const raw = input.positionals.key;
      const key = typeof raw === 'string' ? requireKey(raw) : null;
      const limit = intOption(input, 'limit', 20, 100);
      const { client } = await ctx.auth();
      const releases = await withReadRetry(() => getReleases(client, CLI_ENVIRONMENT));
      const rows = releases
        .filter((release) => !key || release.config_key === key)
        .slice(0, limit)
        .map((release) => {
          const releaseKey = release.config_key as string;
          const known = (managedConfigKeys as readonly string[]).includes(releaseKey);
          return {
            release_id: release.id,
            key: releaseKey,
            label: known ? label(releaseKey as ManagedConfigKey) : releaseKey,
            runtime_version: release.runtime_version,
            released_at: release.released_at,
            released_by: release.released_by_name,
            rollback_of: release.rollback_of_release_id,
            ...(input.options['with-values']
              ? {
                  value: known
                    ? releaseValue(releaseKey as ManagedConfigKey, release)
                    : release.value,
                }
              : {}),
          };
        });
      return {
        data: rows,
        human: table(rows, [
          'released_at',
          'label',
          'runtime_version',
          'released_by',
          'release_id',
        ]),
      };
    },
  },
  {
    name: 'config rollback',
    summary: '把配置恢复到某次发布的值（会生成一次新发布）',
    write: true,
    positionals: [
      { name: 'release-id', description: '发布记录 id（见 config releases）', required: true },
    ],
    async run(ctx, input) {
      const releaseId = requiredPositional(input, 'release-id');
      const { client } = await ctx.auth();
      const releases = await withReadRetry(() => getReleases(client, CLI_ENVIRONMENT));
      const target = releases.find((release) => release.id === releaseId);
      if (!target) throw new CliError('not_found', '发布记录不存在（只能回滚最近 100 条内的发布）');
      const key = requireKey(target.config_key);
      const state = await loadState(client, key);
      const diff = diffValues(publishedValue(key, state.config), releaseValue(key, target));
      await ctx.confirm({
        action: `回滚 ${label(key)}（${key}）到版本 ${target.runtime_version}，立即在生产生效`,
        human: formatDiff(diff),
        preview: diff,
      });
      const release = await rollbackRelease(client, releaseId);
      return {
        data: { key, release_id: release.id, runtime_version: release.runtime_version, diff },
        human: `已回滚，线上版本 ${release.runtime_version}`,
      };
    },
  },
];
