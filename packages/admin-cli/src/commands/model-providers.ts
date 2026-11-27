import {
  fetchProviderBalance,
  fetchProviderModelDirectory,
  fetchSurplusProviderMarket,
} from '@miniapp/admin-client';
import { LlmModelProviderSchema, RelayProviderSchema, SurplusModelIdSchema } from '@miniapp/shared';
import { requiredPositional, type CommandSpec } from '../command';
import { CliError } from '../errors';

export const modelProviderCommands: CommandSpec[] = [
  {
    name: 'model-provider models',
    summary: '读取平台授权文本模型目录',
    write: false,
    positionals: [
      {
        name: 'provider',
        description: 'openrouter / venice / surplus / packy / onexmodel',
        required: true,
      },
    ],
    options: { refresh: { type: 'boolean', description: '刷新供应商目录缓存' } },
    async run(ctx, input) {
      const parsed = LlmModelProviderSchema.safeParse(requiredPositional(input, 'provider'));
      if (!parsed.success) throw new CliError('validation_failed', 'Unsupported model provider');
      const { config } = await ctx.auth();
      return {
        data: await fetchProviderModelDirectory(
          config.apiUrl,
          parsed.data,
          input.options.refresh === true
        ),
      };
    },
  },
  {
    name: 'model-provider balance',
    summary: '读取 Packy / OneXModel 账户原生额度（与 Key 限额不同）',
    write: false,
    positionals: [{ name: 'provider', description: 'packy / onexmodel', required: true }],
    options: { refresh: { type: 'boolean', description: '刷新短期余额缓存' } },
    async run(ctx, input) {
      const parsed = RelayProviderSchema.safeParse(requiredPositional(input, 'provider'));
      if (!parsed.success) throw new CliError('validation_failed', 'Unsupported balance provider');
      const { client, config } = await ctx.auth();
      return {
        data: await fetchProviderBalance(
          client,
          config.apiUrl,
          parsed.data,
          input.options.refresh === true
        ),
      };
    },
  },
  {
    name: 'model-provider market',
    summary: '读取 Surplus 某模型各供应商的公开报价与 24h 表现（填 Surplus 路由规则时参考）',
    write: false,
    positionals: [
      { name: 'model', description: 'Surplus 模型名，如 deepseek-v4.1-flash-1017', required: true },
    ],
    async run(ctx, input) {
      const parsed = SurplusModelIdSchema.safeParse(requiredPositional(input, 'model'));
      if (!parsed.success) throw new CliError('validation_failed', 'Invalid Surplus model id');
      const { client, config } = await ctx.auth();
      return { data: await fetchSurplusProviderMarket(client, config.apiUrl, parsed.data) };
    },
  },
];
