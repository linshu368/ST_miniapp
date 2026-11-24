import { fetchProviderBalance, fetchProviderModelDirectory } from '@miniapp/admin-client';
import { LlmModelProviderSchema, RelayProviderSchema } from '@miniapp/shared';
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
];
