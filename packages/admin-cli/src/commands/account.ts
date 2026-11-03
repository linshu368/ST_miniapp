import { getCurrentAdmin, setOperatorName, type AdminUser } from '@miniapp/admin-client';
import { CLI_ENVIRONMENT, createAdminSupabaseClient } from '../client';
import { stringOption, type CommandSpec, type Ctx } from '../command';
import { CliError, classifyError } from '../errors';
import { note } from '../output';
import { ask, askHidden, isInteractive } from '../prompt';
import {
  adminHome,
  clearSession,
  loadConfig,
  normalizeApiUrl,
  readSessionMeta,
  saveConfig,
  withSessionLock,
  writeSessionMeta,
} from '../store';

const HEALTH_TIMEOUT_MS = 5_000;

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1]) continue;
    values[match[1]] = (match[2] ?? '').replace(/^['"]|['"]$/g, '');
  }
  return values;
}

async function checkHealth(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function describeAdmin(admin: AdminUser, extra: Record<string, unknown> = {}) {
  return {
    environment: CLI_ENVIRONMENT,
    email: admin.email,
    display_name: admin.display_name,
    role: admin.role,
    can_access_prod: admin.can_access_prod,
    can_write: admin.role !== 'viewer' && admin.can_access_prod,
    ...extra,
  };
}

function humanAdmin(data: ReturnType<typeof describeAdmin>): string {
  return [
    `环境：生产`,
    `账号：${data.email}`,
    `操作人：${data.display_name ?? '（未设置）'}`,
    `角色：${data.role}${data.can_write ? '（可写）' : '（只读）'}`,
  ].join('\n');
}

export const accountCommands: CommandSpec[] = [
  {
    name: 'setup',
    summary: '配置生产后端地址与公开 anon key（每台电脑一次）',
    write: false,
    options: {
      'api-url': { type: 'string', description: '生产后端地址，如 https://xxx.up.railway.app' },
      'anon-key': { type: 'string', description: 'Supabase 公开 anon key（与运营平台网页相同）' },
      'from-env-file': {
        type: 'string',
        description: '从 env 文件读取 VITE_ADMIN_PROD_API_URL / VITE_ADMIN_PROD_SUPABASE_ANON_KEY',
      },
    },
    examples: ['pnpm admin setup', 'pnpm admin setup --from-env-file packages/admin/.env.local'],
    async run(ctx, input) {
      let apiUrl = stringOption(input, 'api-url');
      let anonKey = stringOption(input, 'anon-key');
      const envFile = stringOption(input, 'from-env-file');
      if (envFile) {
        const values = parseEnvFile(ctx.readText(envFile));
        apiUrl ??= values.VITE_ADMIN_PROD_API_URL;
        anonKey ??= values.VITE_ADMIN_PROD_SUPABASE_ANON_KEY;
      }
      if ((!apiUrl || !anonKey) && isInteractive()) {
        apiUrl ||= await ask('生产后端地址（https://...）：');
        anonKey ||= await askHidden('Supabase anon key（输入不回显）：');
      }
      if (!apiUrl || !anonKey) {
        throw new CliError(
          'usage',
          '需要 --api-url 与 --anon-key，或 --from-env-file，或在终端交互输入'
        );
      }
      const config = { apiUrl: normalizeApiUrl(apiUrl), anonKey: anonKey.trim() };
      saveConfig(config);
      const reachable = await checkHealth(config.apiUrl);
      const data = { saved_to: adminHome(), api_url: config.apiUrl, backend_reachable: reachable };
      return {
        data,
        human: `已保存到 ${adminHome()}\n后端：${config.apiUrl}（${reachable ? '可连接' : '暂时无法连接，请检查地址'}）\n下一步：pnpm admin login`,
      };
    },
  },
  {
    name: 'login',
    summary: '用本人运营账号登录生产（只能由本人在终端交互执行）',
    write: false,
    options: {
      email: { type: 'string', description: '运营账号邮箱（不填则交互输入）' },
      name: { type: 'string', description: '操作人姓名，记录在发布历史里（不填则交互输入）' },
    },
    async run(_ctx, input) {
      // 密码只能由人输入：AI 或脚本调用时直接拒绝，也就永远拿不到密码。
      if (!isInteractive()) {
        throw new CliError('usage', 'login 必须由本人在自己的终端交互执行：pnpm admin login');
      }
      const config = loadConfig();
      const previous = readSessionMeta();
      const email =
        stringOption(input, 'email') ||
        (await ask(`邮箱${previous ? `（${previous.email}）` : ''}：`)) ||
        previous?.email;
      if (!email) throw new CliError('usage', '需要邮箱');
      const password = await askHidden('密码（输入不回显）：');
      const operatorName =
        stringOption(input, 'name') ||
        (await ask(`操作人姓名${previous ? `（${previous.operatorName}）` : ''}：`)) ||
        previous?.operatorName;
      if (!operatorName) throw new CliError('usage', '需要操作人姓名，它会记录在发布历史里');

      const client = createAdminSupabaseClient(config);
      clearSession();
      const signIn = await withSessionLock(() =>
        client.auth.signInWithPassword({ email, password })
      );
      if (signIn.error || !signIn.data.user) {
        clearSession();
        throw classifyError(signIn.error ?? new Error('登录失败'));
      }
      try {
        await setOperatorName(client, operatorName);
        const admin = await getCurrentAdmin(client, signIn.data.user.id);
        if (!admin.can_access_prod) {
          throw new CliError('permission_denied', '该账号没有生产环境权限，已退出登录');
        }
        writeSessionMeta({ email, operatorName, loggedInAt: new Date().toISOString() });
        const data = describeAdmin(admin);
        return { data, human: `登录成功\n${humanAdmin(data)}` };
      } catch (error) {
        await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
        clearSession();
        throw error;
      }
    },
  },
  {
    name: 'logout',
    summary: '退出登录并删除本机会话',
    write: false,
    async run() {
      try {
        const client = createAdminSupabaseClient(loadConfig());
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // 退出失败（网络、会话已失效）不影响删除本机会话。
      }
      clearSession();
      return { data: { logged_out: true }, human: '已退出，本机会话已删除' };
    },
  },
  {
    name: 'whoami',
    summary: '查看当前登录的运营账号、角色和权限',
    write: false,
    async run(ctx: Ctx) {
      const { client, userId } = await ctx.auth();
      const { data: user, error } = await client.auth.getUser();
      if (error || !user.user) throw classifyError(error ?? new Error('登录状态已失效'));
      const admin = await getCurrentAdmin(client, userId);
      const meta = readSessionMeta();
      const data = describeAdmin(admin, { logged_in_at: meta?.loggedInAt ?? null });
      if (!data.can_write) note('提示：当前账号只读，写命令会被数据库拒绝。');
      return { data, human: humanAdmin(data) };
    },
  },
];
