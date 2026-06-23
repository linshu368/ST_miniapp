/**
 * sync-engine / lib / config.ts
 *
 * 环境变量加载与校验。
 * 使用 Zod 在启动时做 fail-fast 校验，避免运行到一半才发现配置缺失。
 * 调用 loadConfig() 一次后缓存，后续模块直接 import { config }。
 */

import 'dotenv/config';
import { z } from 'zod';

const DEFAULT_PROD_SUPABASE_PROJECT_REF = 'wbtsfzozlmurljvglhpn';
const DEFAULT_TEST_SUPABASE_PROJECT_REF = 'qekxjxpznjvoccvmgozk';
const DATABASE_ENV_VALUES = ['development', 'test', 'production'] as const;
type DatabaseEnvironment = (typeof DATABASE_ENV_VALUES)[number];
type DatabaseTarget = 'test' | 'production';

function extractSupabaseProjectRef(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/https?:\/\/([a-z0-9]{20})\.supabase\.co/i);
  return match?.[1] ?? null;
}

function normalizeDatabaseEnvironment(value: string | undefined): DatabaseEnvironment {
  if (DATABASE_ENV_VALUES.includes(value as DatabaseEnvironment)) {
    return value as DatabaseEnvironment;
  }
  if (
    process.env.RAILWAY_ENVIRONMENT === 'production' ||
    process.env.RAILWAY_ENVIRONMENT_NAME === 'production'
  ) {
    return 'production';
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

function applyDatabaseTargetEnvironment(): void {
  const databaseEnv = normalizeDatabaseEnvironment(process.env.DATABASE_ENV);
  const prodProjectRef = process.env.PROD_SUPABASE_PROJECT_REF || DEFAULT_PROD_SUPABASE_PROJECT_REF;
  const testProjectRef = process.env.TEST_SUPABASE_PROJECT_REF || DEFAULT_TEST_SUPABASE_PROJECT_REF;
  const databaseTarget: DatabaseTarget = databaseEnv === 'production' ? 'production' : 'test';
  const prefix = databaseTarget === 'production' ? 'PROD' : 'TEST';

  for (const name of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PROJECT_REF',
  ] as const) {
    const selectedValue = process.env[`${prefix}_${name}`];
    if (selectedValue) {
      process.env[name] = selectedValue;
    }
  }

  process.env.DATABASE_ENV = databaseEnv;
  process.env.SUPABASE_PROJECT_REF =
    process.env.SUPABASE_PROJECT_REF ||
    (databaseTarget === 'production' ? prodProjectRef : testProjectRef);
}

applyDatabaseTargetEnvironment();

const ConfigSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL 必须是合法 URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10, 'SUPABASE_SERVICE_ROLE_KEY 不能为空'),
  DATABASE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SUPABASE_PROJECT_REF: z.string().optional(),
  PROD_SUPABASE_PROJECT_REF: z.string().default(DEFAULT_PROD_SUPABASE_PROJECT_REF),
  TEST_SUPABASE_PROJECT_REF: z.string().default(DEFAULT_TEST_SUPABASE_PROJECT_REF),
  ALLOW_PROD_DATABASE: z.string().optional(),

  // ST 文件系统
  ST_DATA_PATH: z.string().min(1, 'ST_DATA_PATH 不能为空'),
  ST_PLATFORM_ASSETS_PATH: z.string().min(1, 'ST_PLATFORM_ASSETS_PATH 不能为空'),

  // ST 服务
  ST_BASE_URL: z.string().url('ST_BASE_URL 必须是合法 URL'),
  ST_ADMIN_USERNAME: z.string().min(1).default('admin'),
  ST_ADMIN_PASSWORD: z.string().min(1, 'ST_ADMIN_PASSWORD 不能为空'),
  ST_USER_PASSWORD_SECRET: z.string().min(16, 'ST_USER_PASSWORD_SECRET 至少 16 位'),

  // 健康监控（默认 9090，0 = 禁用）
  HEALTH_PORT: z
    .string()
    .default('9090')
    .transform((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 65535) {
        throw new Error('HEALTH_PORT 必须是 0-65535 的整数');
      }
      return n;
    }),

  // Bridge API 内网端口（供 backend 调用 provision，默认 9091，0 = 禁用）
  BRIDGE_API_PORT: z
    .string()
    .default('9091')
    .transform((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 65535) {
        throw new Error('BRIDGE_API_PORT 必须是 0-65535 的整数');
      }
      return n;
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`环境变量配置校验失败：\n${details}\n\n请检查 .env 文件是否存在且已正确填写。`);
  }

  const data = result.data;
  const projectRefs = [
    data.SUPABASE_PROJECT_REF,
    extractSupabaseProjectRef(data.SUPABASE_URL),
  ].filter((value): value is string => Boolean(value));
  const uniqueProjectRefs = Array.from(new Set(projectRefs));
  const projectRef = uniqueProjectRefs[0] || null;

  if (uniqueProjectRefs.length > 1) {
    throw new Error(`Supabase 配置中出现多个 project ref：${uniqueProjectRefs.join(', ')}`);
  }

  if (data.DATABASE_ENV === 'test' && projectRef !== data.TEST_SUPABASE_PROJECT_REF) {
    throw new Error(
      `DATABASE_ENV=test 必须连接测试 Supabase 项目 ${data.TEST_SUPABASE_PROJECT_REF}，当前为 ${projectRef ?? 'unknown'}`
    );
  }

  if (data.DATABASE_ENV === 'production' && projectRef !== data.PROD_SUPABASE_PROJECT_REF) {
    throw new Error(
      `DATABASE_ENV=production 必须连接生产 Supabase 项目 ${data.PROD_SUPABASE_PROJECT_REF}，当前为 ${projectRef ?? 'unknown'}`
    );
  }

  if (
    data.DATABASE_ENV !== 'production' &&
    projectRef === data.PROD_SUPABASE_PROJECT_REF &&
    data.ALLOW_PROD_DATABASE !== '1'
  ) {
    throw new Error(
      '非 production 环境禁止连接生产 Supabase 项目。若确需临时操作，必须显式设置 ALLOW_PROD_DATABASE=1'
    );
  }

  _config = data;
  return _config;
}

/** 模块级单例，供其他模块直接 import 使用 */
export const config = new Proxy({} as Config, {
  get(_target, key: string) {
    return loadConfig()[key as keyof Config];
  },
});
