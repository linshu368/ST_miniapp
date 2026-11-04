import { parseArgs } from 'node:util';
import { Ctx, type CommandInput, type CommandSpec } from './command';
import { COMMANDS } from './commands';
import { CliError, EXIT_CODES, classifyError } from './errors';
import { printError, printSuccess } from './output';

const GLOBAL_OPTIONS = {
  json: {
    type: 'boolean',
    description: '输出 {ok,data} / {ok:false,error} JSON（AI 调用请总是加）',
  },
  yes: {
    type: 'boolean',
    short: 'y',
    description: '确认执行写操作（生产）。只在用户明确同意后使用',
  },
  help: { type: 'boolean', short: 'h', description: '查看命令说明' },
} as const;

function usage(spec: CommandSpec): string {
  const positionals = (spec.positionals ?? [])
    .map((p) => (p.required ? `<${p.name}${p.variadic ? '...' : ''}>` : `[${p.name}]`))
    .join(' ');
  const options = Object.keys(spec.options ?? {})
    .map((name) => `[--${name}]`)
    .join(' ');
  return ['pnpm -s admin', spec.name, positionals, options, spec.write ? '[--yes]' : '', '[--json]']
    .filter(Boolean)
    .join(' ');
}

function describe(spec: CommandSpec) {
  return {
    name: spec.name,
    summary: spec.summary,
    write: spec.write,
    usage: usage(spec),
    positionals: spec.positionals ?? [],
    options: spec.options ?? {},
    examples: spec.examples ?? [],
  };
}

function catalog() {
  return {
    tool: 'mijing-admin',
    environment: 'production',
    notes: [
      '只操作生产环境，身份是本人的运营账号；权限与网页运营平台一致。',
      '登录：pnpm admin login --email <白名单邮箱> --name <操作人>（免密，邮箱须在后端白名单内）。',
      '写操作（write=true）不带 --yes 时返回 confirmation_required 和差异预览，不会改任何东西。',
      '配置改动流程：config describe → config get → config draft set → config diff → 用户确认 → config publish --yes → config get 复核。',
      'AI 调用请用 pnpm -s admin ... --json（在仓库子目录用 pnpm -s -w admin），stdout 只有一段 JSON；不加 -s 时 pnpm 会往 stdout 打印脚本横幅。',
    ],
    global_options: GLOBAL_OPTIONS,
    exit_codes: EXIT_CODES,
    commands: COMMANDS.map(describe),
  };
}

function humanCatalog(): string {
  const width = Math.max(...COMMANDS.map((spec) => spec.name.length));
  return [
    'mijing-admin：运营平台命令行（生产环境）',
    '',
    ...COMMANDS.map(
      (spec) => `  ${spec.name.padEnd(width)}  ${spec.write ? '[写] ' : ''}${spec.summary}`
    ),
    '',
    '全局参数：--json 输出 JSON；--yes 确认写操作；<命令> --help 查看详情',
    'AI 调用：pnpm -s admin help --json',
  ].join('\n');
}

function humanCommand(spec: CommandSpec): string {
  const lines = [
    `${spec.name}${spec.write ? '（写操作，需确认）' : ''}`,
    spec.summary,
    '',
    `用法：${usage(spec)}`,
  ];
  for (const p of spec.positionals ?? []) lines.push(`  <${p.name}>  ${p.description}`);
  for (const [name, option] of Object.entries(spec.options ?? {}))
    lines.push(`  --${name}  ${option.description}`);
  if (spec.examples?.length)
    lines.push('', '示例：', ...spec.examples.map((example) => `  ${example}`));
  return lines.join('\n');
}

/** 取最长匹配的命令名（最多三个词），其余参数交给 parseArgs。 */
function matchCommand(argv: string[]): {
  spec: CommandSpec | null;
  rest: string[];
  words: string[];
} {
  const words: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-') || words.length === 3) break;
    words.push(arg);
  }
  for (let length = words.length; length > 0; length -= 1) {
    const name = words.slice(0, length).join(' ');
    const spec = COMMANDS.find((candidate) => candidate.name === name);
    if (spec) return { spec, rest: argv.slice(length), words };
  }
  return { spec: null, rest: argv, words };
}

function parseInput(spec: CommandSpec, rest: string[]) {
  const optionSpecs = { ...GLOBAL_OPTIONS, ...(spec.options ?? {}) };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      options: Object.fromEntries(
        Object.entries(optionSpecs).map(([name, option]) => [
          name,
          {
            type: option.type,
            ...('short' in option && option.short ? { short: option.short } : {}),
          },
        ])
      ),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new CliError('usage', `${(error as Error).message}。用法：${usage(spec)}`);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals: CommandInput['positionals'] = {};
  const remaining = [...parsed.positionals];
  for (const positional of spec.positionals ?? []) {
    if (positional.variadic) {
      positionals[positional.name] = remaining.splice(0);
    } else {
      positionals[positional.name] = remaining.shift();
    }
    const value = positionals[positional.name];
    const missing = value === undefined || (Array.isArray(value) && value.length === 0);
    if (positional.required && missing && !values.help) {
      throw new CliError('usage', `缺少参数 <${positional.name}>。用法：${usage(spec)}`);
    }
  }
  if (remaining.length > 0) {
    throw new CliError('usage', `多余的参数：${remaining.join(' ')}。用法：${usage(spec)}`);
  }
  return { values, positionals };
}

export async function runCli(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  try {
    const { spec, rest, words } = matchCommand(argv);
    if (!spec) {
      const helpTarget = words[0] === 'help' ? matchCommand(words.slice(1)).spec : null;
      if (helpTarget) {
        printSuccess(json, describe(helpTarget), humanCommand(helpTarget));
        return 0;
      }
      if (
        words.length === 0 ||
        words[0] === 'help' ||
        argv.includes('--help') ||
        argv.includes('-h')
      ) {
        printSuccess(json, catalog(), humanCatalog());
        return 0;
      }
      throw new CliError(
        'usage',
        `未知命令：${words.join(' ')}。执行 pnpm -s admin help 查看全部命令`
      );
    }
    const { values, positionals } = parseInput(spec, rest);
    if (values.help) {
      printSuccess(json, describe(spec), humanCommand(spec));
      return 0;
    }
    const ctx = new Ctx({ json, yes: values.yes === true });
    const result = await spec.run(ctx, { positionals, options: values });
    printSuccess(json, result.data, result.human);
    return 0;
  } catch (error) {
    return printError(json, classifyError(error));
  }
}
