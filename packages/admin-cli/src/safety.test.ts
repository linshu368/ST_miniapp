import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  getManagedConfigs: vi.fn(),
  getDrafts: vi.fn(),
  saveDraft: vi.fn(),
  publishDraft: vi.fn(),
}));

vi.mock('@miniapp/admin-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@miniapp/admin-client')>()),
  ...rpc,
}));

import { Ctx } from './command';
import { configCommands } from './commands/config';
import { accountCommands } from './commands/account';
import { moveIds } from './commands/characters';
import { runCli } from './cli';
import { COMMANDS } from './commands';
import { CliError, classifyError } from './errors';
import { FileSessionStorage, saveConfig } from './store';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mijing-admin-test-'));
  process.env.MIJING_ADMIN_HOME = home;
  vi.resetAllMocks();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MIJING_ADMIN_HOME;
});

/** 不连网络：auth() 直接返回假 client，RPC 全部被 mock。 */
function ctx(input: { yes?: boolean } = {}): Ctx {
  const context = new Ctx({ json: true, yes: input.yes ?? false });
  vi.spyOn(context, 'auth').mockResolvedValue({
    client: {} as never,
    config: { apiUrl: 'https://api.example.invalid', anonKey: 'anon' },
    accessToken: 'token',
    userId: 'user-1',
  });
  return context;
}

function command(name: string) {
  const spec = [...configCommands, ...accountCommands].find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`missing ${name}`);
  return spec;
}

function stubState(draftValue?: unknown) {
  rpc.getManagedConfigs.mockResolvedValue([
    {
      key: 'miniapp_checkin_veteran_credits',
      value: 20,
      version: 3,
      updated_at: '2026-11-01T00:00:00Z',
      text_value: null,
      description: null,
    },
  ]);
  rpc.getDrafts.mockResolvedValue(
    draftValue === undefined
      ? []
      : [
          {
            id: 'draft-1',
            environment: 'production',
            config_key: 'miniapp_checkin_veteran_credits',
            value: draftValue,
            text_value: null,
            description: null,
            base_version: 3,
            status: 'draft',
            created_at: '2026-11-02T00:00:00Z',
            updated_at: '2026-11-02T00:00:00Z',
            published_at: null,
          },
        ]
  );
}

async function expectCliError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe(code);
  return error as CliError;
}

describe('写操作门禁', () => {
  it('没有 --yes 时拒绝保存草稿，并在 details 里给出差异，不调用写接口', async () => {
    stubState();
    const error = await expectCliError(
      command('config draft set').run(ctx(), {
        positionals: { key: 'miniapp_checkin_veteran_credits' },
        options: { value: '30' },
      }),
      'confirmation_required'
    );
    expect(error.details).toMatchObject({ preview: [{ kind: 'changed', before: 20, after: 30 }] });
    expect(rpc.saveDraft).not.toHaveBeenCalled();
  });

  it('带 --yes 时按生产环境保存草稿', async () => {
    stubState();
    rpc.saveDraft.mockResolvedValue({ id: 'draft-2', base_version: 3 });
    await command('config draft set').run(ctx({ yes: true }), {
      positionals: { key: 'miniapp_checkin_veteran_credits' },
      options: { value: '30' },
    });
    expect(rpc.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'production',
        key: 'miniapp_checkin_veteran_credits',
        value: 30,
      })
    );
  });

  it('发布也受同一门禁约束', async () => {
    stubState(30);
    await expectCliError(
      command('config publish').run(ctx(), {
        positionals: { key: 'miniapp_checkin_veteran_credits' },
        options: {},
      }),
      'confirmation_required'
    );
    expect(rpc.publishDraft).not.toHaveBeenCalled();
  });
});

describe('草稿护栏与校验', () => {
  it('已有与线上不同的草稿时默认拒绝覆盖', async () => {
    stubState(25);
    await expectCliError(
      command('config draft set').run(ctx({ yes: true }), {
        positionals: { key: 'miniapp_checkin_veteran_credits' },
        options: { value: '30' },
      }),
      'draft_exists'
    );
    expect(rpc.saveDraft).not.toHaveBeenCalled();
  });

  it('--replace-draft 时允许覆盖', async () => {
    stubState(25);
    rpc.saveDraft.mockResolvedValue({ id: 'draft-1', base_version: 3 });
    await command('config draft set').run(ctx({ yes: true }), {
      positionals: { key: 'miniapp_checkin_veteran_credits' },
      options: { value: '30', 'replace-draft': true },
    });
    expect(rpc.saveDraft).toHaveBeenCalledOnce();
  });

  it('与线上相同且没有草稿时不写入', async () => {
    stubState();
    const result = await command('config draft set').run(ctx({ yes: true }), {
      positionals: { key: 'miniapp_checkin_veteran_credits' },
      options: { value: '20' },
    });
    expect(result.data).toMatchObject({ saved: false, reason: 'no_changes' });
    expect(rpc.saveDraft).not.toHaveBeenCalled();
  });

  it('本地校验失败时给出字段路径，不调用接口', async () => {
    const error = await expectCliError(
      command('config validate').run(ctx(), {
        positionals: { key: 'miniapp_checkin_veteran_credits' },
        options: { value: '-5' },
      }),
      'validation_failed'
    );
    expect(error.details).toMatchObject({ issues: [{ path: '(值)' }] });
    expect(rpc.getManagedConfigs).not.toHaveBeenCalled();
  });

  it('未知配置 key 返回 not_found', async () => {
    await expectCliError(
      command('config get').run(ctx(), { positionals: { key: 'no_such_key' }, options: {} }),
      'not_found'
    );
  });
});

describe('登录与本机会话', () => {
  it('非交互环境且没给邮箱时直接报用法错误，不请求后端', async () => {
    saveConfig({ apiUrl: 'https://api.example.invalid', anonKey: 'anon' });
    await expectCliError(command('login').run(ctx(), { positionals: {}, options: {} }), 'usage');
  });

  it('会话与配置文件只有本人可读写', () => {
    saveConfig({ apiUrl: 'https://api.example.invalid', anonKey: 'anon' });
    new FileSessionStorage().setItem('k', 'v');
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'session.json')).mode & 0o777).toBe(0o600);
  });

  it('未 setup 时返回 setup_required', async () => {
    const context = new Ctx({ json: true, yes: false });
    await expectCliError(context.auth(), 'setup_required');
  });
});

describe('错误分类', () => {
  it.each([
    ['viewer accounts are read-only', 'permission_denied'],
    ['admin is not permitted to access configured environment: production', 'permission_denied'],
    ['config changed after draft creation; save a new draft', 'conflict'],
    ['JWT expired', 'auth_required'],
    ['TypeError: fetch failed', 'unavailable'],
    ['something unexpected', 'unknown'],
  ])('%s → %s', (message, code) => {
    expect(classifyError(new Error(message)).code).toBe(code);
  });
});

describe('布局编辑', () => {
  const layout = { listed_ids: ['a', 'b', 'c'], delisted_ids: ['d'], deleted_ids: [] };

  it('上架到指定位置并从原列表移除', () => {
    expect(moveIds(layout, ['d'], 'listed', 2)).toEqual({
      listed_ids: ['a', 'd', 'b', 'c'],
      delisted_ids: [],
      deleted_ids: [],
    });
  });

  it('下架和删除只在一个列表里出现', () => {
    expect(moveIds(layout, ['b'], 'delisted').delisted_ids).toEqual(['d', 'b']);
    expect(moveIds(layout, ['a'], 'deleted')).toEqual({
      listed_ids: ['b', 'c'],
      delisted_ids: ['d'],
      deleted_ids: ['a'],
    });
  });
});

describe('命令行入口', () => {
  it('help --json 列出全部命令并标出写操作', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['help', '--json'])).toBe(0);
    const output = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      data: { commands: Array<{ name: string; write: boolean }> };
    };
    write.mockRestore();
    expect(output.data.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(output.data.commands.find((c) => c.name === 'config publish')?.write).toBe(true);
    expect(output.data.commands.find((c) => c.name === 'config get')?.write).toBe(false);
  });

  it('未知参数与未知命令返回用法错误', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['config', 'get', 'x', '--nope', '--json'])).toBe(1);
    expect(await runCli(['nothing', '--json'])).toBe(1);
    write.mockRestore();
  });
});
