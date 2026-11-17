import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getAuthedClient, type AuthedClient } from './client';
import { CliError } from './errors';
import { note } from './output';
import { ask, isInteractive } from './prompt';

export interface OptionSpec {
  type: 'string' | 'boolean';
  description: string;
  short?: string;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required: boolean;
  /** 吃掉剩余全部位置参数，只能放最后。 */
  variadic?: boolean;
}

export interface CommandResult {
  data: unknown;
  /** 人读模式的输出；缺省时打印 data 的 JSON。 */
  human?: string;
}

export interface CommandSpec {
  /** 空格分隔的命令名，如 `config draft set`。 */
  name: string;
  summary: string;
  /** 会改变生产数据的命令：非交互必须带 --yes。 */
  write: boolean;
  positionals?: PositionalSpec[];
  options?: Record<string, OptionSpec>;
  examples?: string[];
  run(ctx: Ctx, input: CommandInput): Promise<CommandResult>;
}

export interface CommandInput {
  positionals: Record<string, string | string[] | undefined>;
  options: Record<string, string | boolean | undefined>;
}

export interface ConfirmRequest {
  /** 一句话说明要做什么，如“发布 充值套餐（miniapp_payment_plans）”。 */
  action: string;
  /** 给人看的差异或动作详情。 */
  human: string;
  /** 给 AI 的结构化差异，出现在 confirmation_required 的 details 里。 */
  preview: unknown;
}

/** 每条命令拿到的运行上下文：输出模式、确认门禁、登录态、路径解析。 */
export class Ctx {
  readonly json: boolean;
  readonly yes: boolean;
  private authed: Promise<AuthedClient> | null = null;

  constructor(input: { json: boolean; yes: boolean }) {
    this.json = input.json;
    this.yes = input.yes;
  }

  auth(): Promise<AuthedClient> {
    this.authed ??= getAuthedClient();
    return this.authed;
  }

  /**
   * 写操作的唯一门禁。带 --yes 直接通过；真人终端显示差异后要求输入 yes；
   * 其他情况（AI、管道）一律拒绝并把差异放进 details，让调用方先给用户看。
   */
  async confirm(request: ConfirmRequest): Promise<void> {
    if (this.yes) return;
    if (isInteractive() && !this.json) {
      note(`\n【生产环境】${request.action}\n${request.human}\n`);
      const answer = await ask('确认执行请输入 yes：');
      if (answer === 'yes') return;
      throw new CliError('confirmation_required', '已取消，未做任何修改');
    }
    throw new CliError(
      'confirmation_required',
      `${request.action}：这是生产环境写操作，需要确认。请把差异给用户确认后，加 --yes 重新执行`,
      { action: request.action, preview: request.preview }
    );
  }

  /** 相对路径按用户执行命令时所在目录解析（经 pnpm 脚本调用时 cwd 会变成仓库根）。 */
  resolvePath(path: string): string {
    if (isAbsolute(path)) return path;
    return resolve(process.env.INIT_CWD || process.cwd(), path);
  }

  readText(path: string): string {
    try {
      return readFileSync(this.resolvePath(path), 'utf8');
    } catch {
      throw new CliError('usage', `无法读取文件：${path}`);
    }
  }

  readBytes(path: string): Buffer {
    try {
      return readFileSync(this.resolvePath(path));
    } catch {
      throw new CliError('usage', `无法读取文件：${path}`);
    }
  }

  readJsonFile(path: string): unknown {
    return parseJson(this.readText(path), path);
  }
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError('validation_failed', `${source} 不是合法 JSON：${(error as Error).message}`);
  }
}

export function stringOption(input: CommandInput, name: string): string | undefined {
  const value = input.options[name];
  return typeof value === 'string' ? value : undefined;
}

export function requiredPositional(input: CommandInput, name: string): string {
  const value = input.positionals[name];
  if (typeof value !== 'string' || !value) throw new CliError('usage', `缺少参数 <${name}>`);
  return value;
}

export function listPositional(input: CommandInput, name: string): string[] {
  const value = input.positionals[name];
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
}

export function intOption(
  input: CommandInput,
  name: string,
  fallback: number,
  max: number
): number {
  const raw = stringOption(input, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new CliError('usage', `--${name} 必须是 1 到 ${max} 的整数`);
  }
  return value;
}
