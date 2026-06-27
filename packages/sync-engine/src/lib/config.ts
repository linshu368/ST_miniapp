/**
 * sync-engine / lib / config.ts
 *
 * 环境变量加载与校验。
 * 使用 Zod 在启动时做 fail-fast 校验，避免运行到一半才发现配置缺失。
 * 调用 loadConfig() 一次后缓存，后续模块直接 import { config }。
 */

import 'dotenv/config';
import {
  DEFAULT_PROD_SUPABASE_PROJECT_REF,
  DEFAULT_TEST_SUPABASE_PROJECT_REF,
  createDatabaseConfig,
} from '@miniapp/shared';
import { z } from 'zod';

createDatabaseConfig({
  env: process.env,
  variableNames: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PROJECT_REF'],
});

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

  // Supabase Storage bucket（角色卡 PNG 存储）
  CHARACTER_STORAGE_BUCKET: z.string().default('character-assets'),

  // ST 服务
  ST_BASE_URL: z.string().url('ST_BASE_URL 必须是合法 URL'),
  ST_ADMIN_USERNAME: z.string().min(1).default('admin'),
  ST_ADMIN_PASSWORD: z.string().min(1, 'ST_ADMIN_PASSWORD 不能为空'),
  ST_USER_PASSWORD_SECRET: z.string().min(16, 'ST_USER_PASSWORD_SECRET 至少 16 位'),
  LLM_PROXY_TOKEN_SECRET: z.string().optional(),

  // ST LLM endpoint 指向平台代理网关的可达地址（写入 settings.json）。
  // 本地默认 backend dev 地址；prod/staging 通过环境变量覆盖为对外可达 URL。
  LLM_PROXY_URL: z.string().url().default('http://localhost:3001/api/platform/llm-proxy/v1'),

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

  // Provision API 内网端口（供 backend 调用 provision，默认 9091，0 = 禁用）
  PROVISION_API_PORT: z
    .string()
    .default('9091')
    .transform((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 65535) {
        throw new Error('PROVISION_API_PORT 必须是 0-65535 的整数');
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

  _config = result.data;
  return _config;
}

/** 模块级单例，供其他模块直接 import 使用 */
export const config = new Proxy({} as Config, {
  get(_target, key: string) {
    return loadConfig()[key as keyof Config];
  },
});
